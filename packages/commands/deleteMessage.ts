/**
 * `/delete_message`：超级管理员把本群的一个用户或频道身份设为删除目标，此后该身份在本群发出的每条
 * 新消息由消息 ingress 认领并排进待删队列（./deleteMessage/queue.ts），经统一 Telegram 出站删除；
 * `/delete_message stop` 撤销。目标只存在主线程内存，进程重启后全部撤销。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import { deleteMessageTargetsByChat } from "../cache/main/deleteMessage";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import {
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  DELETE_MESSAGE_STOP_ARGUMENT_PATTERN,
} from "../consts/deleteMessage";
import { chatAtmosphere } from "../infra/atmosphere";
import { botChatPermissionsIn } from "../infra/botAdmin";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { getChatState } from "../infra/storage/stateStore";
import { replyCommandNotice } from "../infra/telegram";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import type { ParsedDeleteMessageCommand } from "../types/deleteMessage";
import { formatTargetLabel } from "../users/userLabel";
import { rejectUnlessSuperAdmin } from "./commandActor";
import {
  dropQueuedTargetMessageDeletions,
  enqueueTargetMessageDeletion,
  resetTargetMessageDeletionQueue,
} from "./deleteMessage/queue";
import { resolveCommandTarget } from "./targetResolution";

/** 拆出 `/delete_message` 的动作与目标参数（见 DELETE_MESSAGE_STOP_ARGUMENT_PATTERN）。 */
export function parseDeleteMessageCommand(match: string): ParsedDeleteMessageCommand {
  const argument: string = match.trim();
  const stop: RegExpExecArray | null = DELETE_MESSAGE_STOP_ARGUMENT_PATTERN.exec(argument);
  return stop === null
    ? { action: "start", rawTarget: argument }
    : { action: "stop", rawTarget: stop[1] ?? "" };
}

/**
 * 登记删除目标。机器人须有删除消息权限；目标可以是回复对象、@username、用户 id 或频道 id，
 * 不接受机器人自己、当前群身份与超级管理员。解析期间本群已不再初始化时不登记、不回执。
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
  if (getChatState(chatId).isInitEnabled !== true) return;
  const targetLabel: string = formatTargetLabel(target, atmosphere);
  let targets: Set<number> | undefined = deleteMessageTargetsByChat.get(chatId);
  if (targets?.has(target.id) === true) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageExists(targetLabel));
    return;
  }
  if (targets !== undefined && targets.size >= DELETE_MESSAGE_CHAT_TARGET_MAX) {
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageCapacity(DELETE_MESSAGE_CHAT_TARGET_MAX));
    return;
  }
  if (targets === undefined) {
    targets = new Set();
    deleteMessageTargetsByChat.set(chatId, targets);
  }
  targets.add(target.id);
  await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.deleteMessageStarted(targetLabel));
}

/** 撤销本群的一个删除目标；本群最后一个目标撤销时连同群键一并删除。返回目标原先是否在册。 */
function removeDeleteMessageTarget(chatId: number, targetId: number): boolean {
  const targets: Set<number> | undefined = deleteMessageTargetsByChat.get(chatId);
  if (targets?.delete(targetId) !== true) return false;
  if (targets.size === 0) deleteMessageTargetsByChat.delete(chatId);
  return true;
}

/** 撤销删除目标；已排队的条目照常删除。 */
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
  await replyCommandNotice(
    ctx,
    removeDeleteMessageTarget(ctx.chat.id, target.id)
      ? atmosphere.NOTICE_TEXTS.deleteMessageStopped(targetLabel)
      : atmosphere.NOTICE_TEXTS.deleteMessageAbsent(targetLabel)
  );
}

/**
 * 处理 `/delete_message [stop] <目标>`：仅超级管理员本人；回执走统一命令提示清理。私聊命令由初始化网关
 * 拦下（infra/updateGate.ts），频道帖的发起身份是频道本身，过了超级管理员闸的命令都在群里。
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
 * 排进待删队列并认领，不再进入 gag、命令、AI 与复读；队列已满时同样认领。本群没有目标时只有一次
 * Map 查询。同步返回，不分配 Promise（挂载位置见 app/updatePreamble.ts 的前置链）。
 */
export function handleDeleteMessageIngress(message: Message): boolean {
  const targets: Set<number> | undefined = deleteMessageTargetsByChat.get(message.chat.id);
  if (targets === undefined) return false;
  const senderId: number | undefined = message.sender_chat?.id ?? message.from?.id;
  if (senderId === undefined || !targets.has(senderId)) return false;
  enqueueTargetMessageDeletion(message.chat.id, message.message_id);
  return true;
}

/** 群 teardown：撤销本群全部删除目标并摘掉本群尚未发出的待删条目，不发 Telegram 请求。 */
function teardownDeleteMessageInChat(chatId: number): void {
  deleteMessageTargetsByChat.delete(chatId);
  dropQueuedTargetMessageDeletions(chatId);
}

registerChatTeardown("deleteMessage", teardownDeleteMessageInChat);

/** 测试隔离：撤销全部目标并复位待删队列（见 resetTargetMessageDeletionQueue）。 */
export function resetDeleteMessageRuntime(): void {
  deleteMessageTargetsByChat.clear();
  resetTargetMessageDeletionQueue();
}
