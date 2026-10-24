import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";

import { COPY_SUBCOMMAND_PATTERN } from "../consts/copyModes";

import type { CachedUser, CopyMode, GlobalCopyState } from "../types/chatState";
import type { ChatTeardownReason } from "../types/chatTeardown";
import type { CommandTargetMessages } from "../types/commands";
import { adoptCopyTarget, clearCopyTarget, getGlobalCopyState, persistGlobalState } from "../infra/storage/stateStore";
import { replyCommandNotice } from "../infra/telegram";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { logger } from "../infra/logger";
import { describeCopyModeEffect } from "../copy/copyModes";
import { formatUserLabel } from "../users/userLabel";
import { queueAvatarUpdate } from "../copy/avatarQueue";
import { claimCopyCooldownOrReject, releaseCopyCooldownClaim } from "./copyShared";
import { peekCommandTarget, resolveCommandTarget } from "./targetResolution";
import { resolveCommandActor } from "./commandActor";

/**
 * 按复读模式选取包含对应 /copy 参数的目标提示。
 * @param mode 复读变体模式；普通复读时为 undefined。
 * @param atmosphere 当前活跃的文案氛围。
 * @returns 对应复读模式的目标解析提示文案集合。
 */
function copyTargetTextsForMode(mode: CopyMode | undefined, atmosphere: AtmosphereTexts): Readonly<CommandTargetMessages> {
  if (mode === "reverse") return atmosphere.REVERSE_COPY_TARGET_TEXTS;
  if (mode === "nya") return atmosphere.NYA_COPY_TARGET_TEXTS;
  return atmosphere.COPY_TARGET_TEXTS;
}

/**
 * 处理 /copy [reverse|nya] [@username] 与 /copy stop。目标既可以通过 @username
 * 参数指定（要求当前身份缓存中存在该用户名），也可以回复目标消息来指定。
 * 回复目标不要求公开 username 或命中缓存；回复与参数同时给出时必须指向同一身份。
 *
 * 复读目标全局唯一：任一群正在复读时，其他群的 /copy 被拒绝，需先 /copy stop
 * （任何群都能停）。复读行为只发生在发起 /copy 的群里。
 * @param ctx grammY 命令上下文。
 */
export async function handleCopyCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const argument: string = ctx.match.trim();
  const match: RegExpExecArray | null = COPY_SUBCOMMAND_PATTERN.exec(argument);
  const subcommand: string | undefined = match?.[1]?.toLowerCase();
  if (subcommand === "stop") {
    if (match?.[2] !== undefined) {
      await replyCommandNotice(ctx, chatAtmosphere().COPY_USAGE_TEXT);
      return;
    }
    await stopCopy(ctx);
    return;
  }
  const mode: CopyMode | undefined = subcommand === "reverse" || subcommand === "nya"
    ? subcommand
    : undefined;
  const targetArgument: string = mode === undefined ? argument : match?.[2] ?? "";
  const globalCopy: Readonly<GlobalCopyState> = getGlobalCopyState();

  // acknowledged runner 严格串行处理 update；本次命令返回前不会开始另一条命令。
  if (globalCopy.copiedUser !== null) {
    // 这条 /copy 已被拒绝，仅需知道目标是谁来挑文案：用无发送副作用的 peekCommandTarget。
    const targetUser: CachedUser | undefined = peekCommandTarget(ctx.msg, targetArgument);
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    const replyText: string = globalCopy.copiedUser.id === targetUser?.id
      ? atmosphere.NOTICE_TEXTS.copyAlreadyRunning(formatUserLabel(targetUser, atmosphere))
      : atmosphere.NOTICE_TEXTS.copyOtherTarget;
    await replyCommandNotice(ctx, replyText);
    return;
  }

  let cooldownClaim: Awaited<ReturnType<typeof claimCopyCooldownOrReject>> | undefined;
  let copyStarted: boolean = false;
  let targetUser: CachedUser | undefined;
  try {
    cooldownClaim = await claimCopyCooldownOrReject(resolveCommandActor(ctx), chatId, messageId);
    if (cooldownClaim.rejected) return;

    targetUser = await resolveCommandTarget({
      chatId,
      message: ctx.msg,
      botUserId: ctx.me.id,
      rawArgument: targetArgument,
      messages: copyTargetTextsForMode(mode, chatAtmosphere()),
    });
    if (!targetUser) return;

    adoptCopyTarget(targetUser, mode, chatId);
    copyStarted = true;
  } finally {
    if (!copyStarted && cooldownClaim && !cooldownClaim.rejected) {
      await releaseCopyCooldownClaim(cooldownClaim);
    }
  }

  // 成功反馈和头像任务在对应 revision 的全局状态 durable 之后才执行。
  await persistGlobalState("copy started");

  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const targetLabel: string = formatUserLabel(targetUser, atmosphere);
  const startText: string = atmosphere.NOTICE_TEXTS.copyStarting(targetLabel, describeCopyModeEffect(mode, atmosphere));
  await replyCommandNotice(ctx, startText);

  // 头像复制放在后台执行：copiedUser 已经写入，复读逻辑立即生效。
  queueAvatarUpdate({ chatId, target: { kind: "user", user: targetUser }, source: "copy" });
}

/**
 * 处理 /copy stop。复读目标是全局的，在任何群都可以停——不限于当初
 * 发起 /copy 的那个群。
 * @param ctx grammY 命令上下文。
 */
async function stopCopy(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const globalCopy: Readonly<GlobalCopyState> = getGlobalCopyState();

  if (!globalCopy.copiedUser) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.copyNotRunning);
    return;
  }

  clearCopyTarget();
  await persistGlobalState("copy stopped");

  await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.copyStopped);

  // /copy stop 不占全局冷却；仅在停止活动复读后预约恢复默认头像。
  queueAvatarUpdate({ chatId, target: { kind: "default" }, source: "copy" });
}

/**
 * teardown 专用：只停止由指定源群持有的全局 copy。与 /copy stop 一样清状态、等落盘、
 * 再复原默认头像，但复原静默进行：群已不再受管，不在群里发任何消息。
 * @param chatId 被清理的群聊 ID。
 * @param reason 触发群 teardown 的原因。
 */
async function stopCopyOwnedByChat(chatId: number, reason: ChatTeardownReason): Promise<void> {
  const globalCopy: Readonly<GlobalCopyState> = getGlobalCopyState();
  if (globalCopy.copiedUser === null || globalCopy.copyChatId !== chatId) return;
  clearCopyTarget();
  await persistGlobalState("copy teardown");
  logger.log(`Stopped the copy owned by chat ${chatId} after teardown (${reason}).`);
  queueAvatarUpdate({ chatId, target: { kind: "default" }, source: "copy", silent: true });
}

registerChatTeardown("copy", stopCopyOwnedByChat);
