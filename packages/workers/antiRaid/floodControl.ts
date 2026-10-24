/**
 * 刷屏禁言执行侧（入群守卫线程）：在 `FLOOD_WINDOW_MS` 窗口内同一成员发言达到 `FLOOD_MESSAGE_LIMIT` 时，禁言 `FLOOD_MUTE_DURATION_MS` 并发送群内提示。
 */
import type { AtmosphereTexts } from "../../types/atmosphere";
import { workerAtmosphere } from "./atmosphere";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import { muteChatMemberWithOutcome } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import {
  FLOOD_MESSAGE_LIMIT,
  FLOOD_MUTE_DISPATCH_TIMEOUT_MS,
  FLOOD_MUTE_DURATION_MS,
  FLOOD_NOTICE_DISPATCH_TIMEOUT_MS,
  FLOOD_WINDOW_MAX_MEMBERS,
  FLOOD_WINDOW_MS,
} from "../../consts/antiRaid/flood";
import {
  floodWindowCacheStateHolder,
  floodWindowsByChat,
} from "../../cache/workers/antiRaid/flood";
import { signalWithTimeout } from "../../libs/abortSignal";
import { MINUTE_MS, SECOND_MS } from "../../consts/time";
import { TimestampDeque } from "../../libs/timestampDeque";
import { sanitizeDisplayName } from "../../libs/text";
import { botCanRestrictIn } from "./botPermissions";
import { isChatAdmin } from "./adminCache";
import { antiRaidDispatchSignal } from "../../cache/workers/antiRaid/tasks";
import { trackAntiRaidTask } from "./taskTracker";
import type { FloodCandidateMessage } from
  "../../types/antiRaid/protocol";
import type {
  FloodWindowCacheState,
  FloodWindowEntry,
} from "../../types/antiRaid/internal";
import type { MuteChatMemberOutcome } from "../../infra/telegram";

/**
 * 按群与用户双层数值索引读取窗口条目。
 * @param chatId 群组 ID。
 * @param userId 用户 ID。
 * @returns 对应的刷屏滑窗条目；不存在时返回 undefined。
 */
function getFloodWindowEntry(chatId: number, userId: number): FloodWindowEntry | undefined {
  return floodWindowsByChat.get(chatId)?.get(userId);
}

/**
 * 从 LRU 链摘下仍在链中的条目，不触碰分层索引与容量。
 * @param entry 待摘链的刷屏滑窗条目。
 */
function unlinkFloodWindow(entry: FloodWindowEntry): void {
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  const newer: FloodWindowEntry | null = entry.lruNewer;
  const older: FloodWindowEntry | null = entry.lruOlder;
  if (newer === null) state.newest = older;
  else newer.lruOlder = older;
  if (older === null) state.oldest = newer;
  else older.lruNewer = newer;
  entry.lruNewer = null;
  entry.lruOlder = null;
}

/**
 * 把已摘链条目放到 LRU 最新端；只改固定 shape 字段，不重排 Map。
 * @param entry 待挂入最新端的刷屏滑窗条目。
 */
function linkFloodWindowAsNewest(entry: FloodWindowEntry): void {
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  const previousNewest: FloodWindowEntry | null = state.newest;
  entry.lruNewer = null;
  entry.lruOlder = previousNewest;
  if (previousNewest === null) state.oldest = entry;
  else previousNewest.lruNewer = entry;
  state.newest = entry;
}

/**
 * 热命中原地刷新 LRU；已经是最新时不做无效指针写入。
 * @param entry 命中的刷屏滑窗条目。
 */
function touchFloodWindow(entry: FloodWindowEntry): void {
  if (floodWindowCacheStateHolder.current.newest === entry) return;
  unlinkFloodWindow(entry);
  linkFloodWindowAsNewest(entry);
}

/**
 * 从索引和 LRU 同时删除同一对象；异步旧引用无法误删后来复建的条目。
 * @param entry 待移除的刷屏滑窗条目。
 */
function removeFloodWindow(entry: FloodWindowEntry): void {
  const members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(entry.chatId);
  if (members?.get(entry.userId) !== entry) return;
  members.delete(entry.userId);
  if (members.size === 0) floodWindowsByChat.delete(entry.chatId);
  unlinkFloodWindow(entry);
  floodWindowCacheStateHolder.current.entryCount--;
}

/**
 * 记录一次成员发言并判定是否达到刷屏阈值；命中时清空该成员的时间戳队列并返回窗口条目。
 * @param chatId 群组 ID。
 * @param userId 发言成员 ID。
 * @param now 发言观察毫秒时间戳，默认取 `Date.now()`。
 * @returns 达到刷屏阈值时返回该成员的窗口条目；未达到或处于抑制期时返回 undefined。
 */
export function observeMemberMessage(
  chatId: number,
  userId: number,
  now: number = Date.now()
): FloodWindowEntry | undefined {
  let entry: FloodWindowEntry | undefined = getFloodWindowEntry(chatId, userId);
  if (entry === undefined) {
    const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
    if (state.entryCount >= FLOOD_WINDOW_MAX_MEMBERS && state.oldest !== null) {
      removeFloodWindow(state.oldest);
    }
    let members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(chatId);
    if (members === undefined) {
      members = new Map<number, FloodWindowEntry>();
      floodWindowsByChat.set(chatId, members);
    }
    entry = {
      chatId,
      userId,
      timestamps: new TimestampDeque(FLOOD_MESSAGE_LIMIT),
      lastObservedAt: now,
      suppressedUntil: 0,
      lruNewer: null,
      lruOlder: null,
    };
    members.set(userId, entry);
    state.entryCount++;
    linkFloodWindowAsNewest(entry);
  } else {
    touchFloodWindow(entry);
  }
  entry.lastObservedAt = now;

  // 抑制期内到达的消息一律不计数。
  if (now < entry.suppressedUntil) return undefined;

  entry.timestamps.trim(FLOOD_WINDOW_MS, now);
  entry.timestamps.push(now);
  if (entry.timestamps.size < FLOOD_MESSAGE_LIMIT) return undefined;
  entry.timestamps.clear();
  return entry;
}

/**
 * 格式化刷屏禁言的群内通知文案。
 * @param label 被禁言成员的展示名称。
 * @param atmosphere 当前群风格文案表。
 * @returns 刷屏禁言提示文本。
 */
export function formatFloodMuteNotice(label: string, atmosphere: AtmosphereTexts): string {
  const minutes: number = Math.round(FLOOD_MUTE_DURATION_MS / MINUTE_MS);
  return atmosphere.NOTICE_TEXTS.floodMuted(label, FLOOD_MESSAGE_LIMIT, minutes);
}

/** 核查管理员豁免并禁言刷屏成员所需的参数。 */
interface MuteFlooderParams {
  /** 触发刷屏禁言的候选消息载荷。 */
  message: FloodCandidateMessage;
  /** 触发这次处置的窗口条目，已由调用方置上乐观抑制位。 */
  entry: FloodWindowEntry;
}

/**
 * 瞬时失败时回滚当前窗口条目的乐观抑制位。
 * @param chatId 群组 ID。
 * @param userId 用户 ID。
 * @param entry 发起禁言时持有的滑窗条目引用。
 */
function rollbackSuppression(chatId: number, userId: number, entry: FloodWindowEntry): void {
  if (getFloodWindowEntry(chatId, userId) !== entry) return;
  entry.suppressedUntil = 0;
}

/**
 * 核查管理员豁免后禁言刷屏成员并发送群内通知；每次异步等待后复核窗口条目仍在表中。
 * @param params 禁言处置参数。
 */
async function muteFlooder({ message, entry }: MuteFlooderParams): Promise<void> {
  const stillManaged = (): boolean =>
    getFloodWindowEntry(message.chatId, message.userId) === entry;
  const dispatchAbort: AbortSignal = antiRaidDispatchSignal();
  if (dispatchAbort.aborted) return;
  const targetIsAdmin: boolean | undefined = await isChatAdmin(message.chatId, message.userId, "flooding user");
  // 确认是管理员时保留抑制位；查询失败时回滚抑制位等待下一窗口。
  if (targetIsAdmin === undefined) rollbackSuppression(message.chatId, message.userId, entry);
  if (targetIsAdmin !== false) return;
  if (!stillManaged()) return;

  const mutedUntil: number = Date.now() + FLOOD_MUTE_DURATION_MS;
  const outcome: MuteChatMemberOutcome = await muteChatMemberWithOutcome({
    chatId: message.chatId,
    userId: message.userId,
    mutedUntil,
    dispatchTimeoutMs: FLOOD_MUTE_DISPATCH_TIMEOUT_MS,
    signal: dispatchAbort,
  });
  if (outcome !== "muted") {
    if (outcome === "failed") rollbackSuppression(message.chatId, message.userId, entry);
    return;
  }
  if (stillManaged()) {
    entry.suppressedUntil = Math.max(entry.suppressedUntil, mutedUntil);
  }
  logger.log(
    `Flood control muted user ${message.userId} in chat ${message.chatId} for ` +
    `${Math.round(FLOOD_MUTE_DURATION_MS / SECOND_MS)}s after ${FLOOD_MESSAGE_LIMIT} messages ` +
    `in ${Math.round(FLOOD_WINDOW_MS / SECOND_MS)}s.`
  );
  if (!stillManaged()) return;

  await sendTemporaryMessageFromMain({
    purpose: "notice",
    chatId: message.chatId,
    text: floodMuteNoticeText(message.name, workerAtmosphere()),
    signal: signalWithTimeout(dispatchAbort, FLOOD_NOTICE_DISPATCH_TIMEOUT_MS),
  });
}

/**
 * 生成清洗昵称后的刷屏禁言通知正文（不设 parse_mode，见 docs/cn/04-invariants.md）。
 * @param name 原始成员昵称。
 * @param atmosphere 当前群风格文案表。
 * @returns 清洗昵称后的刷屏禁言通知文本。
 */
function floodMuteNoticeText(name: string, atmosphere: AtmosphereTexts): string {
  return formatFloodMuteNotice(sanitizeDisplayName(name) || atmosphere.NOTICE_TEXTS.unknownUser, atmosphere);
}

/**
 * 处理一条刷屏候选消息：同步记账，达到阈值且未被确证缺少限制权限时派生后台禁言任务。
 * @param message 主线程发来的刷屏候选消息。
 */
export function handleFloodCandidate(message: FloodCandidateMessage): void {
  const entry: FloodWindowEntry | undefined =
    observeMemberMessage(message.chatId, message.userId, message.observedAt);
  if (entry === undefined) return;
  // 乐观抑制：先按本次命中时刻置抑制位再派生任务，瞬时失败由 muteFlooder 回滚。
  entry.suppressedUntil = entry.lastObservedAt + FLOOD_MUTE_DURATION_MS;

  if (botCanRestrictIn(message.chatId) === false) {
    logger.error(
      `Flood control cannot mute user ${message.userId} in chat ${message.chatId}: ` +
      "the bot does not have permission to restrict members."
    );
    return;
  }
  void trackAntiRaidTask({
    task: muteFlooder({ message, entry }).catch((error: unknown): void => {
      rollbackSuppression(message.chatId, message.userId, entry);
      logger.error(`Failed to mute flooding user ${message.userId} in chat ${message.chatId}:`, error);
    }),
  });
}

/**
 * `/flood_control disable`、停管、`/init disable` 或群 teardown：丢掉这个群全部成员的发言窗口。
 * @param chatId 群组 ID。
 */
export function clearChatFloodWindows(chatId: number): void {
  const members: Map<number, FloodWindowEntry> | undefined = floodWindowsByChat.get(chatId);
  if (members === undefined) return;
  for (const entry of members.values()) unlinkFloodWindow(entry);
  floodWindowCacheStateHolder.current.entryCount -= members.size;
  floodWindowsByChat.delete(chatId);
}

/**
 * 清理空闲超过 `FLOOD_WINDOW_MS` 且不在抑制期内的窗口条目。
 * @param now 当前毫秒时间戳，默认取 `Date.now()`。
 * @returns 本次删除的条目数。
 */
export function sweepFloodWindows(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const members of floodWindowsByChat.values()) {
    for (const entry of members.values()) {
      if (now < entry.suppressedUntil) continue;
      if (now - entry.lastObservedAt <= FLOOD_WINDOW_MS) continue;
      removeFloodWindow(entry);
      deleted++;
    }
  }
  return deleted;
}

/** Worker stop/测试隔离时清空窗口表；生产停机由 isolate 回收。 */
export function resetFloodWindows(): void {
  for (const members of floodWindowsByChat.values()) {
    for (const entry of members.values()) {
      entry.lruNewer = null;
      entry.lruOlder = null;
    }
  }
  floodWindowsByChat.clear();
  const state: FloodWindowCacheState = floodWindowCacheStateHolder.current;
  state.entryCount = 0;
  state.newest = null;
  state.oldest = null;
}
