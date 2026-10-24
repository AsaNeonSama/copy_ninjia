/**
 * 主线程每聊天发送调度器的车道队列、在途/退避计数与三层额度（单聊天令牌桶、群分钟窗口、全局秒窗口）计算。
 * @see ../../../docs/cn/04-invariants.md
 */

import type { RawApi } from "grammy";
import { telegramOutboundGateState } from "../../cache/main/telegram";
import {
  sendChatLanes,
  sendGlobalWindow,
  sendSchedulerState,
} from "../../cache/main/telegramSend";
import {
  TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX,
  TELEGRAM_SEND_CHAT_BURST,
  TELEGRAM_SEND_CHAT_CAUTIOUS_MS,
  TELEGRAM_SEND_CHAT_REFILL_MS,
  TELEGRAM_SEND_GLOBAL_LIMIT,
  TELEGRAM_SEND_GLOBAL_WINDOW_MS,
  TELEGRAM_SEND_GROUP_LIMIT,
  TELEGRAM_SEND_GROUP_WINDOW_MS,
} from "../../consts/telegram";
import { TimestampDeque } from "../../libs/timestampDeque";
import type {
  TelegramOutboundJob,
  TelegramRetryLane,
  TelegramSendChatKey,
  TelegramSendLane,
} from "../../types/telegramOutbound";
import { detachAbortListener } from "./outboundSettle";

/** 发送排队已满：单个聊天或全部聊天合计的排队上限，新请求当即拒绝。 */
export class TelegramSendQueueFullError extends Error {
  /**
   * 构造发送排队已满错误。
   * @param scope 触发上限的范围（单聊天或全局）。
   */
  constructor(scope: "chat" | "global") {
    super(
      scope === "chat"
        ? "Telegram send queue for this chat is full."
        : `Telegram send queue reached its ${TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX} request limit.`
    );
    this.name = "TelegramSendQueueFullError";
  }
}

/**
 * 读取消息类别的退避车道状态。
 * @returns 消息类别的退避车道状态。
 */
function messageLane(): TelegramRetryLane {
  return telegramOutboundGateState.lanes.message;
}

/**
 * payload.chat_id 的聊天键：数字原样，`@username` 小写，数字字符串转成数字。
 * @param chatId 请求载荷中的 chat_id。
 * @returns 规范化后的聊天调度键。
 */
export function sendChatKeyOf(chatId: unknown): TelegramSendChatKey {
  if (typeof chatId === "number") return chatId;
  if (typeof chatId !== "string") return "";
  const trimmed: string = chatId.trim();
  if (trimmed.startsWith("@")) return trimmed.toLowerCase();
  const numeric: number = Number(trimmed);
  return trimmed.length > 0 && Number.isSafeInteger(numeric) ? numeric : trimmed;
}

/**
 * 一次发送扣的额度条数：相册按张数、批量复制/转发按条数，其余按单条计。
 * @param method Bot API 方法名。
 * @param payload 请求载荷。
 * @returns 本次请求消耗的发送额度条数。
 */
export function sendCostOf(method: keyof RawApi, payload: unknown): number {
  let units: unknown;
  if (method === "sendMediaGroup") units = (payload as { media?: unknown }).media;
  else if (method === "copyMessages" || method === "forwardMessages") {
    units = (payload as { message_ids?: unknown }).message_ids;
  } else return 1;
  return Array.isArray(units) && units.length > 0 ? units.length : 1;
}

/**
 * 获取或创建指定聊天键的发送车道。
 * @param key 规范化后的聊天调度键。
 * @param now 当前单调时钟毫秒数。
 * @returns 已有或新建的聊天发送车道。
 */
export function laneForKey(key: TelegramSendChatKey, now: number): TelegramSendLane {
  const existing: TelegramSendLane | undefined = sendChatLanes.get(key);
  if (existing !== undefined) return existing;
  const groupClass: boolean = typeof key === "string" || key < 0;
  const lane: TelegramSendLane = {
    key,
    groupClass,
    head: null,
    tail: null,
    queued: 0,
    inFlight: null,
    tokens: TELEGRAM_SEND_CHAT_BURST,
    tokensAt: now,
    minuteWindow: groupClass ? new TimestampDeque(TELEGRAM_SEND_GROUP_LIMIT) : null,
    frozenUntil: 0,
    cautiousUntil: 0,
    lastSendAt: 0,
    timer: null,
    inGlobalRing: false,
  };
  sendChatLanes.set(key, lane);
  return lane;
}

/**
 * 检查发送车道是否仍登记在活跃车道表中。
 * @param lane 待检查的发送车道。
 * @returns 车道仍登记在活跃车道表中时返回 true。
 */
export function isLaneLive(lane: TelegramSendLane): boolean {
  return sendChatLanes.get(lane.key) === lane;
}

/**
 * 将发送任务追加到车道队尾并计入排队总数。
 * @param lane 目标发送车道。
 * @param job 追加到车道队尾并计入排队的发送任务。
 */
export function appendQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  job.previous = lane.tail;
  job.next = null;
  if (lane.tail === null) lane.head = job;
  else lane.tail.next = job;
  lane.tail = job;
  job.state = "sendQueued";
  lane.queued++;
  sendSchedulerState.queuedTotal++;
}

/**
 * 已接纳任务计入在途；退避等待中的任务改计退避等待。
 * @param delta 在途任务计数的增减量。
 */
export function countActive(delta: number): void {
  telegramOutboundGateState.activeCount += delta;
  messageLane().activeCount += delta;
}

/**
 * 调整全局与消息类别限流退避等待计数。
 * @param delta 全局与消息类别限流退避等待计数的增减量。
 */
export function countRetryPending(delta: number): void {
  telegramOutboundGateState.retryPendingCount += delta;
  messageLane().pendingCount += delta;
}

/**
 * 限流退避后放回队首并改计退避等待；不受排队上限约束（任务早已接纳）。
 * @param lane 目标发送车道。
 * @param job 需放回队首重发的任务。
 */
export function prependRetryQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  job.previous = null;
  job.next = lane.head;
  if (lane.head === null) lane.tail = job;
  else lane.head.previous = job;
  lane.head = job;
  job.state = "sendQueued";
  lane.queued++;
  sendSchedulerState.queuedTotal++;
  job.fromRetryQueue = true;
  countActive(-1);
  countRetryPending(1);
}

/**
 * 从车道双向链表摘除任务并扣减排队计数。
 * @param lane 任务所在的发送车道。
 * @param job 从双向链表摘除并扣减排队计数的任务。
 */
export function removeQueued(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  const previous: TelegramOutboundJob | null = job.previous;
  const next: TelegramOutboundJob | null = job.next;
  if (previous === null) lane.head = next;
  else previous.next = next;
  if (next === null) lane.tail = previous;
  else next.previous = previous;
  job.previous = null;
  job.next = null;
  lane.queued--;
  sendSchedulerState.queuedTotal--;
}

/**
 * 已接纳任务的结算记账（按它此刻计在哪一边扣减）；调用方随后 resolve 或 reject。
 * @param job 待结算的发送任务。
 */
export function settleSendJob(job: TelegramOutboundJob): void {
  if (job.fromRetryQueue) {
    job.fromRetryQueue = false;
    countRetryPending(-1);
  } else {
    countActive(-1);
  }
  telegramOutboundGateState.activeJobs.delete(job);
  job.state = "settled";
  detachAbortListener(job);
}

/**
 * 清理发送车道上已挂起的唤醒定时器。
 * @param lane 待清理唤醒定时器的发送车道。
 */
export function clearLaneTimer(lane: TelegramSendLane): void {
  if (lane.timer === null) return;
  clearTimeout(lane.timer);
  lane.timer = null;
}

/**
 * 当前突发容量：保守档内降为单条。
 * @param lane 目标发送车道。
 * @param now 当前单调时钟毫秒数。
 * @returns 当前允许的令牌桶突发上限。
 */
function chatBurst(lane: TelegramSendLane, now: number): number {
  return now < lane.cautiousUntil ? 1 : TELEGRAM_SEND_CHAT_BURST;
}

/**
 * 单聊天两层额度（令牌桶与群类分钟窗口）都满足的最早时刻；已满足时返回 now。
 * @param lane 目标发送车道。
 * @param cost 本次发送所需额度条数。
 * @param now 当前单调时钟毫秒数。
 * @returns 单聊天令牌桶与群分钟窗口同时满足的最早时刻。
 */
export function chatReadyAt(lane: TelegramSendLane, cost: number, now: number): number {
  const burst: number = chatBurst(lane, now);
  if (lane.tokens < burst) {
    lane.tokens = Math.min(burst, lane.tokens + (now - lane.tokensAt) / TELEGRAM_SEND_CHAT_REFILL_MS);
  } else if (lane.tokens > burst) {
    lane.tokens = burst;
  }
  lane.tokensAt = now;
  // 超过桶容量的单次请求等桶满即放行。
  const needed: number = Math.min(cost, burst);
  let readyAt: number = lane.tokens < needed
    ? now + (needed - lane.tokens) * TELEGRAM_SEND_CHAT_REFILL_MS
    : now;
  const window: TimestampDeque | null = lane.minuteWindow;
  if (window !== null) {
    window.trim(TELEGRAM_SEND_GROUP_WINDOW_MS, now);
    const excess: number = window.size + Math.min(cost, TELEGRAM_SEND_GROUP_LIMIT) - TELEGRAM_SEND_GROUP_LIMIT;
    if (excess > 0) {
      readyAt = Math.max(readyAt, (window.peekAt(excess - 1) ?? now) + TELEGRAM_SEND_GROUP_WINDOW_MS);
    }
  }
  return readyAt;
}

/**
 * 全局秒窗口容得下 cost 条的最早时刻；已满足时返回 now。
 * @param cost 本次发送所需额度条数。
 * @param now 当前单调时钟毫秒数。
 * @returns 全局秒窗口满足的最早时刻。
 */
export function globalReadyAt(cost: number, now: number): number {
  sendGlobalWindow.trim(TELEGRAM_SEND_GLOBAL_WINDOW_MS, now);
  const excess: number = sendGlobalWindow.size + Math.min(cost, TELEGRAM_SEND_GLOBAL_LIMIT) - TELEGRAM_SEND_GLOBAL_LIMIT;
  return excess > 0
    ? (sendGlobalWindow.peekAt(excess - 1) ?? now) + TELEGRAM_SEND_GLOBAL_WINDOW_MS
    : now;
}

/**
 * 向目标时间戳双端队列压入指定数量的当前发送时间戳。
 * @param window 目标时间戳双端队列。
 * @param units 压入当前发送时间戳的额度条数。
 * @param now 当前单调时钟毫秒数。
 */
function pushUnits(window: TimestampDeque, units: number, now: number): void {
  for (let index: number = 0; index < units; index++) window.push(now);
}

/**
 * 发出前扣三层额度；令牌可扣成负数，窗口按容量封顶记账。
 * @param lane 目标发送车道。
 * @param cost 本次发送消耗的额度条数。
 * @param now 当前单调时钟毫秒数。
 */
export function consumeQuota(lane: TelegramSendLane, cost: number, now: number): void {
  lane.tokens -= cost;
  if (lane.minuteWindow !== null) pushUnits(lane.minuteWindow, Math.min(cost, TELEGRAM_SEND_GROUP_LIMIT), now);
  pushUnits(sendGlobalWindow, Math.min(cost, TELEGRAM_SEND_GLOBAL_LIMIT), now);
  lane.lastSendAt = now;
}

/**
 * 收到限流响应：只冻结这个聊天，冻结结束后进入保守档；保守档内再命中限流则顺延。
 * @param lane 命中 429 的发送车道。
 * @param retryAfterMs 限流退避毫秒数。
 */
export function freezeLane(lane: TelegramSendLane, retryAfterMs: number): void {
  const frozenUntil: number = performance.now() + retryAfterMs;
  if (frozenUntil > lane.frozenUntil) lane.frozenUntil = frozenUntil;
  lane.cautiousUntil = lane.frozenUntil + TELEGRAM_SEND_CHAT_CAUTIOUS_MS;
}
