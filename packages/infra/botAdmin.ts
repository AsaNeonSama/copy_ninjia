import type { Context } from "grammy";
import { telegramSignal } from "../libs/telegramSignal";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
import {
  clearChatStateField,
  getChatState,
  getOrCreateChatState,
  persistChatState,
  purgeChatStateExceptLockdown,
  saveChatStateInBackground,
} from "./storage/stateStore";
import {
  botPermissionFetches,
  botPermissionObserver,
  botPermissionProbeBackoff,
  botPermissionRequestTokens,
} from "../cache/main/botAdmin";
import { BOT_PERMISSION_PROBE_RETRY_MS } from "../consts/botAdmin";
import {
  botActionPermissionsEqual,
  botChatPermissionsEqual,
  isAdminStatus,
  readBotChatPermissions,
} from "../libs/chatMember";
import { forgetChatBlocklistWork } from "./blocklist/outbox";
import {
  noteBanPermissionObserved,
  sweepBlockedMembers,
} from "./blocklist/sweep";
import { teardownChatRuntime } from "./chatTeardown";
import type { ChatDepartureReason } from "../types/chatTeardown";
import type { ChatState } from "../types/chatState";
import type { BotChatPermissions } from "../types/telegram";
import type { ChatMember, ChatMemberUpdated } from "grammy/types";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "./updateContext";

/**
 * 先等待群运行时 teardown 完成，再执行权威状态更新动作；任一或两侧失败时上抛。
 * @param teardown 群运行时 teardown 的异步任务。
 * @param authoritativeAction teardown 落定后执行的权威状态落盘动作。
 * @param failureMessage 两侧同时失败时构造 AggregateError 的英文消息。
 */
async function completeAfterTeardown(
  teardown: Promise<void>,
  authoritativeAction: () => Promise<void>,
  failureMessage: string
): Promise<void> {
  const [teardownResult]: [PromiseSettledResult<void>] = await Promise.allSettled([teardown]);
  // 先等 teardown 落定再执行权威动作；两侧失败合并上抛。
  const [authoritativeResult]: [PromiseSettledResult<void>] = await Promise.allSettled([authoritativeAction()]);
  const failures: unknown[] = [teardownResult, authoritativeResult].flatMap(
    (result: PromiseSettledResult<void>): unknown[] => result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failureMessage);
}

/**
 * 机器人自己在各群的管理员身份与权限位追踪（存于 `ChatState.botPermissions` 并随 SQLite `chat_states` 持久化）。
 * 由 `my_chat_member` 更新、他人 `chat_member` 更新触发的缺失快照探测以及首次判定时的按需 `getChatMember`
 * 三条路径共同维护，经 `recordBotChatPermissions` 统一落盘，且仅作用于已启用 `/init` 的群。
 * @see ../../docs/cn/04-invariants.md
 */

/**
 * 记录一次确证的完整权限观测；已启用 `/init` 且与已知快照不同时写入、落盘并按动作权限位变化广播。
 * @param chatId 目标群 ID。
 * @param permissions 确证的机器人本群权限快照。
 */
async function recordBotChatPermissions(
  chatId: number,
  permissions: BotChatPermissions
): Promise<void> {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState: ChatState = getOrCreateChatState(chatId);
  const previous: BotChatPermissions | undefined = chatState.botPermissions;
  const changed: boolean = !botChatPermissionsEqual(previous, permissions);
  botPermissionProbeBackoff.delete(chatId);
  if (changed) {
    chatState.botPermissions = permissions;
    if (!permissions.isAdministrator) forgetChatBlocklistWork(chatId);
    await persistChatState(chatId, "bot permissions refresh");
    if (!botActionPermissionsEqual(previous, permissions)) {
      notifyBotPermissionObserver(chatId, permissions);
    }
  }
  if (!permissions.isAdministrator) return;
  noteBanPermissionObserved(chatId, permissions.canRestrictMembers);
  try {
    await sweepBlockedMembers(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to sweep blocklisted members from chat ${chatId} after gaining admin rights:`, error);
  }
}

/**
 * 处理 `my_chat_member` 更新：机器人被任免、权限变更或离群时刷新本群权限快照或执行离群收尾。
 * @param ctx 当前 grammY 更新上下文。
 */
export async function handleMyChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.myChatMember;
  if (!update) return;
  if (update.chat.type !== "group" && update.chat.type !== "supergroup") return;
  if (update.new_chat_member.status === "left" || update.new_chat_member.status === "kicked") {
    await completeChatDeparture(update.chat.id, "departed");
    return;
  }
  const wasAdmin: boolean = isAdminStatus(update.old_chat_member.status);
  const permissions: BotChatPermissions = readBotChatPermissions(update.new_chat_member);
  if (wasAdmin && !permissions.isAdministrator) {
    await completeAfterTeardown(
      teardownChatRuntime(update.chat.id, "lostAuthority"),
      (): Promise<void> => recordBotChatPermissions(update.chat.id, permissions),
      `Failed to complete admin downgrade transition for chat ${update.chat.id}.`
    );
    return;
  }
  await recordBotChatPermissions(update.chat.id, permissions);
}

/**
 * 机器人已离开群（`departed`）或群已不存在（`gone`）时的收尾：
 * 作废权限快照、执行全部 owner 的群 teardown，并在落定后清理黑名单补扫进度与除私密模式记录外的群状态。
 * @param chatId 目标群 ID。
 * @param reason 离群或群不可达的原因。
 */
export async function completeChatDeparture(chatId: number, reason: ChatDepartureReason): Promise<void> {
  forgetBotChatPermissions(chatId);
  await completeAfterTeardown(
    teardownChatRuntime(chatId, reason),
    async (): Promise<void> => {
      forgetChatBlocklistWork(chatId);
      purgeChatStateExceptLockdown(chatId);
      await persistChatState(chatId, `chat ${chatId} state pruned on departure (${reason})`);
    },
    `Failed to complete departure transition for chat ${chatId}.`
  );
}

/**
 * 现查退避闸：放行时武装 `BOT_PERMISSION_PROBE_RETRY_MS` 退避窗口并返回 true，退避期内返回 false。
 * @param chatId 目标群 ID。
 * @returns 允许发起权限探测时返回 true，处于退避期时返回 false。
 */
function admitBotPermissionProbe(chatId: number): boolean {
  const observedAt: number = Date.now();
  const retryAt: number | undefined = botPermissionProbeBackoff.get(chatId);
  if (retryAt !== undefined && observedAt < retryAt) return false;
  botPermissionProbeBackoff.set(chatId, observedAt + BOT_PERMISSION_PROBE_RETRY_MS);
  return true;
}

/**
 * 收到他人 `chat_member` 更新时的管理员观测入口：已有管理员快照时直接触发黑名单补扫；
 * 缺失或冲突时经退避闸在后台发起 `botChatPermissionsIn` 现查。
 * @param chatId 目标群 ID。
 */
export async function markBotAdminObserved(chatId: number): Promise<void> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known?.isAdministrator === true) {
    try {
      await sweepBlockedMembers(chatId);
    } catch (error: unknown) {
      logger.error(`Failed to sweep blocklisted members from chat ${chatId} after an admin observation:`, error);
    }
    return;
  }
  if (known !== undefined) forgetBotChatPermissions(chatId);
  if (!admitBotPermissionProbe(chatId)) return;
  void botChatPermissionsIn(chatId).catch((): void => {
    // 后台探测的请求与落盘错误已由下游记录或交由重放通道处理。
  });
}

/**
 * `/init` 开关切换时作废本群权限快照、在途探测与黑名单补扫进度。
 * @param chatId 目标群 ID。
 */
export function invalidateBotAdminStatus(chatId: number): void {
  forgetBotChatPermissions(chatId);
  forgetChatBlocklistWork(chatId);
}

/**
 * 同步读取已缓存的管理员身份；`undefined` 表示未知。
 * @param chatId 目标群 ID。
 * @returns 已缓存的管理员身份布尔值；尚未缓存时返回 `undefined`。
 */
export function cachedBotAdminStatus(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.isAdministrator;
}

/**
 * 查询机器人在指定群是否为管理员；未知或查询失败时返回 false。
 * @param chatId 目标群 ID。
 * @returns 确证为管理员时返回 true，否则返回 false。
 */
export async function resolveBotAdminStatus(chatId: number): Promise<boolean> {
  const permissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  return permissions?.isAdministrator === true;
}

/**
 * 清除指定群的权限快照并作废在途探测请求。
 * @param chatId 目标群 ID。
 */
export function forgetBotChatPermissions(chatId: number): void {
  const had: boolean = getChatState(chatId).botPermissions !== undefined;
  clearChatStateField(chatId, "botPermissions");
  botPermissionProbeBackoff.delete(chatId);
  botPermissionRequestTokens.delete(chatId);
  botPermissionFetches.delete(chatId);
  if (!had) return;
  saveChatStateInBackground(chatId, "bot permissions forgotten");
  notifyBotPermissionObserver(chatId, undefined);
}

/**
 * 登记权限位变化的下游观察者（反向注册单槽位，见 `docs/cn/04-invariants.md`）。
 * @param observe 接收群 ID 与最新权限快照（或失效时 `undefined`）的观察者回调。
 */
export function registerBotPermissionObserver(
  observe: (chatId: number, permissions: BotChatPermissions | undefined) => void
): void {
  botPermissionObserver.current = observe;
}

/**
 * 向已注册的下游观察者广播一次权限位变化。
 * @param chatId 目标群 ID。
 * @param permissions 最新权限快照；快照被清除时为 `undefined`。
 */
function notifyBotPermissionObserver(chatId: number, permissions: BotChatPermissions | undefined): void {
  try {
    botPermissionObserver.current?.(chatId, permissions);
  } catch (error: unknown) {
    logger.error(`Failed to publish the bot's permission change for chat ${chatId}:`, error);
  }
}

/**
 * 同步读取主线程已观测到的删消息权限；`undefined` 表示未知。
 * @param chatId 目标群 ID。
 * @returns 已缓存的删消息权限布尔值；尚未缓存时返回 `undefined`。
 */
export function botCanDeleteMessagesIn(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.canDeleteMessages;
}

/**
 * 同步读取主线程已观测到的封禁与限制成员权限；`undefined` 表示未知。
 * @param chatId 目标群 ID。
 * @returns 已缓存的封禁与限制成员权限布尔值；尚未缓存时返回 `undefined`。
 */
export function botCanRestrictMembersIn(chatId: number): boolean | undefined {
  return getChatState(chatId).botPermissions?.canRestrictMembers;
}

/**
 * 读取机器人在某群持有的完整管理员权限：已记录的群同步命中，未记录的群按需调用 `getChatMember`
 * 现查并回填（同群并发判定共享同一次在途请求）。
 * @param chatId 目标群 ID。
 * @returns 确证的完整权限快照；现查失败或结果在途被作废时返回 `undefined`。
 */
export async function botChatPermissionsIn(chatId: number): Promise<BotChatPermissions | undefined> {
  const known: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
  if (known !== undefined) return known;

  const pending: Promise<BotChatPermissions | undefined> | undefined = botPermissionFetches.get(chatId);
  if (pending !== undefined) return pending;

  const requestToken: symbol = Symbol(`bot-permissions:${chatId}`);
  botPermissionRequestTokens.set(chatId, requestToken);
  const signal: AbortSignal | undefined = currentUpdateAbortSignal();
  const request: Promise<BotChatPermissions | undefined> = (async (): Promise<BotChatPermissions | undefined> => {
    let member: ChatMember;
    try {
      member = await bot.api.getChatMember(chatId, bot.botInfo.id, telegramSignal(signal));
    } catch (error: unknown) {
      throwIfUpdateAborted(signal);
      logger.error(`Failed to read the bot's own permissions in chat ${chatId}:`, error);
      return undefined;
    }
    if (botPermissionRequestTokens.get(chatId) !== requestToken) return undefined;
    const authoritative: BotChatPermissions | undefined = getChatState(chatId).botPermissions;
    if (authoritative !== undefined) return authoritative;
    const permissions: BotChatPermissions = readBotChatPermissions(member);
    await recordBotChatPermissions(chatId, permissions);
    return permissions;
  })();
  const tracked: Promise<BotChatPermissions | undefined> = request.finally((): void => {
    if (botPermissionFetches.get(chatId) === tracked) botPermissionFetches.delete(chatId);
    if (botPermissionRequestTokens.get(chatId) === requestToken) {
      botPermissionRequestTokens.delete(chatId);
    }
  });
  // 令牌已被同步失效换掉时，不登记旧请求的 fetch。
  if (botPermissionRequestTokens.get(chatId) === requestToken) {
    botPermissionFetches.set(chatId, tracked);
  }
  return tracked;
}
