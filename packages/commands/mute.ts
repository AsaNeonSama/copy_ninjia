import type { AtmosphereTexts } from "../types/atmosphere";
import type { AtmosphereNotices } from "../types/atmosphereNotices";
import { chatAtmosphere } from "../infra/atmosphere";

import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { MuteChatMemberOutcome, UnmuteChatMemberOutcome } from "../infra/telegram";
import { muteChatMemberWithOutcome, replyCommandNotice, unmuteChatMemberWithOutcome } from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { botChatPermissionsIn } from "../infra/botAdmin";
import type { BotChatPermissions } from "../types/telegram";
import { MUTE_DISPATCH_MIN_REMAINING_MS, MUTE_MAX_DURATION_MS, MUTE_MIN_DURATION_MS } from "../consts/commands";

import { describeBotPermissionGap } from "../libs/botPermissionGap";
import {
  formatDurationCn,
  parseDurationTokenMs,
} from "../libs/durationToken";
import { splitTrailingToken } from "./arguments";
import type { TrailingTokenSplit } from "./arguments";
import { resolveCommandTarget } from "./targetResolution";
import { rejectUnlessPermitted } from "./commandActor";

/**
 * 把 `/mute` 的时长 token 解析成毫秒数并收敛进合法区间。
 *
 * 形态不合法（缺单位、带小数、非正数等）返回 undefined，交给调用方回用法
 * 提示；合法但越界的值收敛到边界，实际生效的时长由战报念出。上下限见
 * consts/commands.ts 的 MUTE_MIN_DURATION_MS / MUTE_MAX_DURATION_MS。数值超出
 * 安全整数时同样落进最大值收敛。
 * 导出仅为可测试性。
 * @param token 原始时长 token 字符串（如 `"10m"`、`"2h"`）。
 * @returns 收敛到合法区间的毫秒数；形态非法时返回 undefined。
 */
export function parseMuteDurationMs(token: string): number | undefined {
  const durationMs: number | undefined = parseDurationTokenMs(token);
  if (durationMs === undefined) return undefined;
  return Math.min(MUTE_MAX_DURATION_MS, Math.max(MUTE_MIN_DURATION_MS, durationMs));
}

/**
 * `forbidden` 结局的回执。按机器人自己的权限快照分辨：确证不是管理员或缺
 * 「限制与封禁成员」时点名原因；快照缺失或该位齐全时两种成因都说明。
 * 具体错误已由统一错误边界记进日志。
 * @param chatId 目标群聊 ID。
 * @param targetLabel 已格式化的目标展示标签。
 * @param command 触发的操作类型（`"mute"` 或 `"unmute"`）。
 * @returns 拼装好的权限不足回执文案。
 */
async function forbiddenReplyText(
  chatId: number,
  targetLabel: string,
  command: "mute" | "unmute"
): Promise<string> {
  const notices: Readonly<AtmosphereNotices> = chatAtmosphere().NOTICE_TEXTS;
  const permissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  const reason: string | undefined = permissions === undefined
    ? undefined
    : describeBotPermissionGap(permissions, "canRestrictMembers", notices);
  if (command === "mute") {
    return reason === undefined
      ? notices.muteForbidden(targetLabel)
      : notices.muteBotLacksRights(targetLabel, reason);
  }
  return reason === undefined
    ? notices.unmuteForbidden(targetLabel)
    : notices.unmuteBotLacksRights(targetLabel, reason);
}

/**
 * /mute 与 /unmute 共用的入口校验：发起人持有对应权限、且本群是超级群。
 * 任一不满足时回复嘲讽/说明并返回 false，调用方直接 return。
 * `restrictChatMember` 只对超级群有效，非超级群回执 muteSupergroupOnly，不解析目标
 * （同 antiRaid/floodControl.ts 只在超级群计数的口径）。
 * @param ctx grammY 命令上下文。
 * @param command 触发的操作类型（`"mute"` 或 `"unmute"`）。
 * @returns 校验通过时返回 true；已发送拒绝回执时返回 false。
 */
async function passesMuteCommandGate(ctx: CommandContext<Context>, command: "mute" | "unmute"): Promise<boolean> {
  const permission: "isCanMute" | "isCanUnMute" =
    command === "mute" ? "isCanMute" : "isCanUnMute";
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    permission,
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.muteRejected(actorLabel, command)
  );
  if (actor === undefined) return false;

  if (ctx.chat.type !== "supergroup") {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.muteSupergroupOnly);
    return false;
  }

  return true;
}

/**
 * 目标是频道身份（频道马甲/匿名管理员）时回复 muteChannelTarget 并返回 true：
 * restrictChatMember 只认真实用户（同 antiRaid/floodControl.ts 不计数的口径）。
 * @param ctx grammY 命令上下文。
 * @param targetUser 已解析出的目标身份。
 * @returns 目标为不可限制的频道身份且已发送拒绝回执时返回 true；真实用户返回 false。
 */
async function rejectUnrestrictableTarget(
  ctx: CommandContext<Context>,
  targetUser: CachedUser
): Promise<boolean> {
  if (targetUser.isChannel !== true) return false;
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.muteChannelTarget(formatTargetLabel(targetUser, atmosphere)));
  return true;
}

/**
 * 处理 /mute 指令：临时收走目标在本群的全部发言权限，到点由 Telegram 按
 * `until_date` 自动恢复；与刷屏禁言（workers/antiRaid/floodControl.ts）复用
 * 同一个 API 封装与权限集，本进程不排恢复计时器、不写任何持久化状态，提前
 * 解除走 /unmute。派发截止也共用同一条契约：`until_date` 是入队前算好的
 * 绝对时刻，两条路径都给 `muteChatMemberWithOutcome` 传 `dispatchTimeoutMs`，
 * 各自的预算见 MUTE_DISPATCH_MIN_REMAINING_MS 与 FLOOD_MUTE_DISPATCH_TIMEOUT_MS。
 *
 * 参数形态：时长必填且必须是最后一个 token（`数字+m/h/d`，见
 * parseMuteDurationMs），目标用回复消息、@username 或用户 id 指定（时长带
 * 单位字母、id 是纯数字，形态互斥）。仅持有 isCanMute 的身份可用（超级管理员
 * 恒持有，见 infra/identityPolicy/whitelist.ts）；目标在白名单保护范围内（`isWhitelisted`，含超级
 * 管理员）时拒绝，与自动处置的排除边界一致（见 antiRaid/adDetect.ts）。
 *
 * 成功战报与失败提示一样走 sendCommandMessage 的默认路径，自动清理（见
 * docs/cn/04-invariants.md）；`/mute` 不属于长期保留例外。
 * @param ctx grammY 命令上下文。
 */
export async function handleMuteCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;

  if (!await passesMuteCommandGate(ctx, "mute")) return;

  // 时长取最后一个 token，前面剩下的整段是目标参数（可为空，此时目标来自回复）；
  // 先校验时长再解析目标，时长非法时回用法提示。
  const { last: durationToken, rest: targetArgument }: TrailingTokenSplit = splitTrailingToken(ctx.match);
  const durationMs: number | undefined = durationToken === undefined ? undefined : parseMuteDurationMs(durationToken);
  if (durationMs === undefined) {
    await replyCommandNotice(ctx, chatAtmosphere().MUTE_USAGE_TEXT);
    return;
  }

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    // 接受裸用户 id；时长 token 带单位字母，纯数字 id 不会被当成时长。
    acceptUserId: true,
    // 下方的白名单保护检查读取 isWhitelisted，预热失败时拒绝执行。
    requireIdentityPolicies: true,
    messages: chatAtmosphere().MUTE_TARGET_TEXTS,
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  // 白名单身份不可禁言（口径同自动处置的 isWhitelisted 边界，超级管理员已含在内）。
  if (isWhitelisted(targetUser.id)) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await replyCommandNotice(ctx, atmosphere.NOTICE_TEXTS.muteProtected(formatTargetLabel(targetUser, atmosphere)));
    return;
  }

  const targetLabel: string = formatTargetLabel(targetUser, chatAtmosphere());
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
    mutedUntil: Date.now() + durationMs,
    // 与刷屏禁言同一条契约：`until_date` 是入队前算好的绝对时刻，请求命中
    // restrict 类 429 后在独立车道按 retry_after 排队；派发预算耗尽即放弃，
    // 按 failed 回执（见 consts/commands.ts 的 MUTE_DISPATCH_MIN_REMAINING_MS）。
    dispatchTimeoutMs: durationMs - MUTE_DISPATCH_MIN_REMAINING_MS,
  });
  if (outcome === "muted") {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.muteDone(targetLabel, formatDurationCn(durationMs)));
    return;
  }
  // failed 是限流/网络抖动，值得再试；forbidden 的措辞见 forbiddenReplyText。
  const failureText: string = outcome === "forbidden"
    ? await forbiddenReplyText(chatId, targetLabel, "mute")
    : chatAtmosphere().NOTICE_TEXTS.muteFailed(targetLabel);
  await replyCommandNotice(ctx, failureText);
}

/**
 * 处理 /unmute 指令：立刻恢复目标在本群的发言权限（全权限置真，实际能力仍
 * 与群默认权限取交集，见 consts/telegram.ts 的 UNMUTED_CHAT_PERMISSIONS）。
 * 不带时长参数；仅持有 `isCanUnMute` 的身份可用，目标同样支持回复消息、`@username` 或裸用户 ID。
 * 目标本来就没被禁言时 Telegram 同样返回成功，不事先区分；无需白名单保护检查，也不强制预热身份策略。
 * @param ctx grammY 命令上下文。
 */
export async function handleUnmuteCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;

  if (!await passesMuteCommandGate(ctx, "unmute")) return;

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    acceptUserId: true,
    messages: chatAtmosphere().UNMUTE_TARGET_TEXTS,
  });
  if (!targetUser) return;
  if (await rejectUnrestrictableTarget(ctx, targetUser)) return;

  const targetLabel: string = formatTargetLabel(targetUser, chatAtmosphere());
  const outcome: UnmuteChatMemberOutcome = await unmuteChatMemberWithOutcome({
    chatId,
    userId: targetUser.id,
  });
  if (outcome === "unmuted") {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.unmuteDone(targetLabel));
    return;
  }
  const failureText: string = outcome === "forbidden"
    ? await forbiddenReplyText(chatId, targetLabel, "unmute")
    : chatAtmosphere().NOTICE_TEXTS.unmuteFailed(targetLabel);
  await replyCommandNotice(ctx, failureText);
}
