/**
 * `/delete_message`：超级管理员把本群的一个用户或频道身份设为删除目标，此后该身份在本群发出的每条
 * 新消息由消息 ingress 认领并排进待删队列（./deleteMessage/queue.ts），经统一 Telegram 出站删除；
 * `/delete_message stop` 撤销。目标保存在群状态的 deleteMessageTargets，随 `chat_states` 持久化，
 * 登记与撤销都等落盘确认后才回执。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import {
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  DELETE_MESSAGE_STOP_ARGUMENT_PATTERN,
} from "../consts/deleteMessage";
import { IDENTITY_DATABASE_PATH } from "../consts/paths";
import { storageRowSource } from "../database/validation/storageRows";
import { chatAtmosphere } from "../infra/atmosphere";
import { botChatPermissionsIn } from "../infra/botAdmin";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { getChatStateCache, persistChatState } from "../infra/storage/stateStore";
import { replyCommandNotice } from "../infra/telegram";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser, ChatState } from "../types/chatState";
import type { ParsedDeleteMessageCommand } from "../types/deleteMessage";
import { formatTargetLabel } from "../users/userLabel";
import { rejectUnlessSuperAdmin } from "./commandActor";
import {
  dropQueuedTargetMessageDeletions,
  enqueueTargetMessageDeletion,
} from "./deleteMessage/queue";
import { resolveCommandTarget } from "./targetResolution";

/**
 * 拆出 `/delete_message` 的动作与目标参数（见 DELETE_MESSAGE_STOP_ARGUMENT_PATTERN）。
 * @param match 命令参数原文（`ctx.match`）。
 * @returns 解析出的动作（`"start"` 或 `"stop"`）与目标参数文本。
 */
export function parseDeleteMessageCommand(match: string): ParsedDeleteMessageCommand {
  const argument: string = match.trim();
  const stop: RegExpExecArray | null = DELETE_MESSAGE_STOP_ARGUMENT_PATTERN.exec(argument);
  return stop === null
    ? { action: "start", rawTarget: argument }
    : { action: "stop", rawTarget: stop[1] ?? "" };
}

/**
 * 登记删除目标并等待群状态落盘。机器人须有删除消息权限；目标可以是回复对象、@username、用户 id
 * 或频道 id，不接受机器人自己、当前群身份与超级管理员。解析期间本群已不再初始化时不登记、不回执。
 * @param ctx grammY 命令上下文。
 * @param rawTarget 目标参数原文。
 */
async function startDeletingTargetMessages(
  ctx: CommandContext<Context>,
  rawTarget: string
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const permissionGap: string | undefined = describeBotPermissionGap(
    await botChatPermissionsIn(chatId),
    "canDeleteMessages",
    atmosphere.NOTICE_TEXTS
  );
  if (permissionGap !== undefined) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageMissingRights(permissionGap));
    return;
  }
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: rawTarget,
    acceptUserId: true,
    acceptChatId: true,
    messages: atmosphere.DELETE_MESSAGE_TARGET_TEXTS,
    currentChatTargetText: atmosphere.NOTICE_TEXTS.deleteMessageCurrentChat,
  });
  if (target === undefined) return;
  if (target.id === SUPER_ADMIN_USER_ID) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageSuperAdminTarget);
    return;
  }
  const chatState: ChatState | undefined = getChatStateCache().get(chatId);
  if (chatState?.isInitEnabled !== true) return;
  const targetLabel: string = formatTargetLabel(target, atmosphere);
  const current: readonly number[] | undefined = chatState.deleteMessageTargets;
  if (current?.includes(target.id) === true) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageExists(targetLabel));
    return;
  }
  if (current !== undefined && current.length >= DELETE_MESSAGE_CHAT_TARGET_MAX) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageCapacity(DELETE_MESSAGE_CHAT_TARGET_MAX));
    return;
  }
  chatState.deleteMessageTargets = current === undefined ? [target.id] : [...current, target.id];
  await persistChatState(chatId, "delete message target added");
  await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageStarted(targetLabel));
}

/**
 * 撤销删除目标并等待群状态落盘；已排队的条目照常删除，目标原本不在册时不落盘。
 * @param ctx grammY 命令上下文。
 * @param rawTarget 目标参数原文。
 */
async function stopDeletingTargetMessages(
  ctx: CommandContext<Context>,
  rawTarget: string
): Promise<void> {
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId: ctx.chat.id,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: rawTarget,
    acceptUserId: true,
    acceptChatId: true,
    messages: atmosphere.DELETE_MESSAGE_STOP_TARGET_TEXTS,
  });
  if (target === undefined) return;
  const targetLabel: string = formatTargetLabel(target, atmosphere);
  const chatState: ChatState | undefined = getChatStateCache().get(ctx.chat.id);
  const current: readonly number[] | undefined = chatState?.deleteMessageTargets;
  if (chatState === undefined || current?.includes(target.id) !== true) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageAbsent(targetLabel));
    return;
  }
  const remaining: readonly number[] = current.filter((id: number): boolean => id !== target.id);
  chatState.deleteMessageTargets = remaining.length === 0 ? undefined : remaining;
  await persistChatState(ctx.chat.id, "delete message target removed");
  await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageStopped(targetLabel));
}

/**
 * 处理 `/delete_message [stop] <目标>`：仅超级管理员本人；回执走统一命令提示清理。私聊命令由初始化网关
 * 拦下（infra/updateGate.ts），频道帖的发起身份是频道本身，过了超级管理员闸的命令都在群里。
 * @param ctx grammY 命令上下文。
 */
export async function handleDeleteMessageCommand(ctx: CommandContext<Context>): Promise<void> {
  const actor: CachedUser | undefined = await rejectUnlessSuperAdmin(
    ctx,
    (_actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.deleteMessageRejected
  );
  if (actor === undefined) return;
  const parsed: ParsedDeleteMessageCommand = parseDeleteMessageCommand(ctx.match);
  if (parsed.action === "stop") await stopDeletingTargetMessages(ctx, parsed.rawTarget);
  else await startDeletingTargetMessages(ctx, parsed.rawTarget);
}

/**
 * 命令前的消息 ingress：发送者（有 sender_chat 时取它，否则取 from）是本群删除目标时，把这条消息
 * 排进待删队列并认领，不再进入 gag、命令、AI 与复读；队列已满时同样认领。本群没有目标时只读一个
 * 字段。同步返回，不分配 Promise（挂载位置见 app/updatePreamble.ts 的前置链）。
 * @param message 入站的 Telegram 消息。
 * @param chatState 前置链在同一同步段读到的本群状态快照。
 * @returns 已认领并拦截该消息时返回 true；未命中删除目标时返回 false。
 */
export function handleDeleteMessageIngress(message: Message, chatState: Readonly<ChatState>): boolean {
  const targets: readonly number[] | undefined = chatState.deleteMessageTargets;
  if (targets === undefined) return false;
  const senderId: number | undefined = message.sender_chat?.id ?? message.from?.id;
  if (senderId === undefined || !targets.includes(senderId)) return false;
  enqueueTargetMessageDeletion(message.chat.id, message.message_id);
  return true;
}

/**
 * 群 teardown：同步摘掉本群尚未发出的待删条目并撤销本群全部删除目标，随后等待群状态落盘；
 * 不发 Telegram 请求。
 * @param chatId 被清理的群聊 ID。
 */
async function teardownDeleteMessageInChat(chatId: number): Promise<void> {
  dropQueuedTargetMessageDeletions(chatId);
  const chatState: ChatState | undefined = getChatStateCache().get(chatId);
  if (chatState?.deleteMessageTargets === undefined) return;
  chatState.deleteMessageTargets = undefined;
  await persistChatState(chatId, "delete message targets cleared");
}

registerChatTeardown("deleteMessage", teardownDeleteMessageInChat);

/**
 * 启动阶段的致命互斥校验：配置里的超级管理员不得出现在任何群的删除目标里。排在群状态热读副本
 * 载入之后；校验失败时抛错，启动以非零码退出。
 * @param superAdminUserId 部署配置的超级管理员身份 ID。
 */
export function assertSuperAdminNotDeleteMessageTarget(superAdminUserId: number): void {
  for (const [chatId, chatState] of getChatStateCache()) {
    const index: number = chatState.deleteMessageTargets?.indexOf(superAdminUserId) ?? -1;
    if (index < 0) continue;
    throw new Error(
      `${storageRowSource(IDENTITY_DATABASE_PATH, "chat_states", chatId)}: ` +
      `$.deleteMessageTargets[${index}] must not be the configured super admin identity; ` +
      "expected the delete targets and super_admin_user_id to stay disjoint."
    );
  }
}
