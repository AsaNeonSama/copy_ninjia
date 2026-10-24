/**
 * 主线程每聊天发送调度器。出站闸（./outboundGate.ts）把发送类请求（isTelegramMessageRequest）交到
 * 这里，其余类别仍走按类别的限流退避。按 Telegram FAQ 的公开限额主动控速，三层额度都满足才发出：
 * - 单聊天令牌桶：每 TELEGRAM_SEND_CHAT_REFILL_MS 补一个，容量 TELEGRAM_SEND_CHAT_BURST（保守档内降为单条）；
 * - 群类聊天（负数 id 与 `@username`）：任意 TELEGRAM_SEND_GROUP_WINDOW_MS 内不超过 TELEGRAM_SEND_GROUP_LIMIT 条；
 * - 全局：任意 TELEGRAM_SEND_GLOBAL_WINDOW_MS 内不超过 TELEGRAM_SEND_GLOBAL_LIMIT 条。
 * 相册按张数、批量复制/转发按条数扣额度；单次条数超过桶容量时等桶满后放行，余下欠额顺延，
 * 窗口按其容量封顶记账。
 *
 * 每个聊天一条 FIFO、单槽在途，保持同一聊天的发送顺序；只差全局额度的车道进全局轮转队列
 * 依次放行。收到限流响应只冻结这个聊天 retry_after，冻结结束后 TELEGRAM_SEND_CHAT_CAUTIOUS_MS 内
 * 突发容量降为单条，期间再命中限流则顺延。额度在真正发出时才扣，排队中取消按双向指针直接出队、不扣额度。
 *
 * 计数口径与出站闸一致：已接纳、未结算的任务（含等额度的）计入 activeCount 与 message 类的
 * activeCount；因限流在聊天 FIFO 里等待重发的任务改计入 retryPendingCount 与 message 类的
 * pendingCount，重新发出时计回在途。运行态见 cache/main/telegramSend.ts。
 * @see ../../../docs/cn/04-invariants.md
 */

import type { RawApi } from "grammy";
import { telegramOutboundGateState } from "../../cache/main/telegram";
import {
  sendChatLanes,
  sendGlobalRing,
  sendGlobalWindow,
  sendSchedulerState,
} from "../../cache/main/telegramSend";
import {
  TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX,
  TELEGRAM_MESSAGE_GROUP_PENDING_MAX,
  TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX,
  TELEGRAM_SEND_GROUP_WINDOW_MS,
  TELEGRAM_TIMER_MAX_DELAY_MS,
} from "../../consts/telegram";
import { toErrorOr } from "../../libs/errorMessage";
import type {
  TelegramOutboundJob,
  TelegramSendLane,
} from "../../types/telegramOutbound";
import {
  detachAbortListener,
  jobAbortReason,
  releaseResponseBody,
  settleDrainWaitersIfIdle,
} from "./outboundSettle";
import { telegramRetryAfterMilliseconds } from "./outboundRetryPolicy";
import {
  appendQueued,
  chatReadyAt,
  clearLaneTimer,
  consumeQuota,
  countActive,
  countRetryPending,
  freezeLane,
  globalReadyAt,
  isLaneLive,
  laneForKey,
  prependRetryQueued,
  removeQueued,
  sendChatKeyOf,
  sendCostOf,
  settleSendJob,
  TelegramSendQueueFullError,
} from "./sendLane";

export { TelegramSendQueueFullError } from "./sendLane";

/**
 * 单聊天车道定时器到期回调：清空定时器槽位，并在车道仍存活时尝试推进发送。
 * @param lane 定时器到期后若仍存活则推进发送的车道。
 */
function onLaneTimer(lane: TelegramSendLane): void {
  lane.timer = null;
  if (isLaneLive(lane)) pumpSendLane(lane, false);
}

/**
 * 本车道唯一定时器改到 at；每次被挡下最多重挂一次。超过 TELEGRAM_TIMER_MAX_DELAY_MS 的等待
 * 分段：定时器提前到点后 pumpSendLane / retireIdleLane 按冻结与窗口复查并续挂。
 * @param lane 目标发送车道。
 * @param at 目标唤醒的单调时钟时刻（毫秒）。
 * @param now 当前单调时钟毫秒数。
 */
function armLaneTimer(lane: TelegramSendLane, at: number, now: number): void {
  clearLaneTimer(lane);
  lane.timer = setTimeout(
    onLaneTimer,
    Math.min(Math.max(0, Math.ceil(at - now)), TELEGRAM_TIMER_MAX_DELAY_MS),
    lane
  );
  lane.timer.unref();
}

/**
 * 空闲车道：分钟窗口、保守档与冻结都已结束时删除，否则挂一个到期复查的定时器。已有定时器
 * 时不重挂，它到点后复查并按新的到期时刻续挂。
 * @param lane 待检查退役的空闲车道。
 * @param now 当前单调时钟毫秒数。
 */
function retireIdleLane(lane: TelegramSendLane, now: number): void {
  const expiresAt: number = Math.max(
    lane.lastSendAt + TELEGRAM_SEND_GROUP_WINDOW_MS,
    lane.cautiousUntil,
    lane.frozenUntil
  );
  if (expiresAt > now) {
    if (lane.timer === null) armLaneTimer(lane, expiresAt, now);
    return;
  }
  clearLaneTimer(lane);
  sendChatLanes.delete(lane.key);
}

/**
 * 按全局轮转队列队首任务的额度缺口挂起全局唤醒定时器（已有定时器时跳过）。
 * @param now 当前单调时钟毫秒数。
 */
function armGlobalTimer(now: number): void {
  if (sendSchedulerState.globalTimer !== null) return;
  const lane: TelegramSendLane | undefined = sendGlobalRing.peek();
  const cost: number = lane?.head?.sendCost ?? 1;
  sendSchedulerState.globalTimer = setTimeout(
    onGlobalTimer,
    Math.max(0, Math.ceil(globalReadyAt(cost, now) - now))
  );
  sendSchedulerState.globalTimer.unref();
}

/**
 * 将仅等待全局额度的发送车道加入全局轮转队列并确保全局定时器已挂起。
 * @param lane 仅等待全局额度、待加入全局轮转队列的发送车道。
 * @param now 当前单调时钟毫秒数。
 */
function joinGlobalRing(lane: TelegramSendLane, now: number): void {
  clearLaneTimer(lane);
  if (!lane.inGlobalRing) {
    lane.inGlobalRing = true;
    sendGlobalRing.push(lane);
  }
  armGlobalTimer(now);
}

/**
 * 车道因排队任务全部取消而腾空时退出全局轮转环，并同步清理或重挂全局定时器。
 * @param lane 待移出全局轮转队列的发送车道。
 */
function leaveGlobalRing(lane: TelegramSendLane): void {
  if (!lane.inGlobalRing) return;
  const wasHead: boolean = sendGlobalRing.peek() === lane;
  lane.inGlobalRing = false;
  sendGlobalRing.removeValue(lane);
  if (sendGlobalRing.size === 0) {
    if (sendSchedulerState.globalTimer !== null) {
      clearTimeout(sendSchedulerState.globalTimer);
      sendSchedulerState.globalTimer = null;
    }
    return;
  }
  if (wasHead && sendSchedulerState.globalTimer !== null) {
    clearTimeout(sendSchedulerState.globalTimer);
    sendSchedulerState.globalTimer = null;
    armGlobalTimer(performance.now());
  }
}

/** 全局额度腾出后按轮转顺序放行：每条车道一次只放一条，额度不够时续挂定时器。 */
function onGlobalTimer(): void {
  sendSchedulerState.globalTimer = null;
  if (telegramOutboundGateState.aborting) return;
  for (;;) {
    const lane: TelegramSendLane | undefined = sendGlobalRing.peek();
    if (lane === undefined) return;
    const job: TelegramOutboundJob | null = lane.head;
    const now: number = performance.now();
    if (job !== null && isLaneLive(lane) && globalReadyAt(job.sendCost, now) > now) {
      armGlobalTimer(now);
      return;
    }
    sendGlobalRing.shift();
    lane.inGlobalRing = false;
    if (isLaneLive(lane)) pumpSendLane(lane, true);
  }
}

/**
 * 网络结算后释放车道的在途位；调用方取消过的任务也要等到这一刻。
 * @param lane 目标发送车道。
 * @param job 已完成网络结算的任务。
 */
function releaseInFlight(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  if (lane.inFlight === job) lane.inFlight = null;
}

/**
 * 单次在途发送结算后的统一收尾：若车道仍存活则继续推进本车道，并检查全局排空等待者。
 * @param lane 单次在途发送结算后待推进并检查排空的发送车道。
 */
function afterSendSettled(lane: TelegramSendLane): void {
  if (isLaneLive(lane)) pumpSendLane(lane, false);
  settleDrainWaitersIfIdle();
}

/**
 * 处理发送任务的响应：非限流则结算兑现，命中 429 则冻结本聊天并放回队首重发。
 * @param lane 任务所属的发送车道。
 * @param job 收到响应的发送任务。
 * @param response 下游调用返回的响应对象。
 */
function handleSendResponse(lane: TelegramSendLane, job: TelegramOutboundJob, response: unknown): void {
  releaseInFlight(lane, job);
  const retryAfterMs: number | undefined = telegramRetryAfterMilliseconds(response);
  if (retryAfterMs !== undefined && isLaneLive(lane)) freezeLane(lane, retryAfterMs);
  if (job.state !== "active") {
    releaseResponseBody(response);
  } else if (retryAfterMs === undefined) {
    settleSendJob(job);
    job.resolve(response);
  } else {
    // 回到本聊天队首，下一次尝试取新响应，本次响应丢弃。
    releaseResponseBody(response);
    prependRetryQueued(lane, job);
  }
  afterSendSettled(lane);
}

/**
 * 处理发送任务抛出的异常：释放车道在途位、对仍处于 `active` 状态的任务结算拒绝，并推进后续调度。
 * @param lane 任务所属的发送车道。
 * @param job 发生异常、需释放车道在途位并结算的发送任务。
 * @param error 捕获到的异常值。
 */
function handleSendFailure(lane: TelegramSendLane, job: TelegramOutboundJob, error: unknown): void {
  releaseInFlight(lane, job);
  if (job.state === "active") {
    settleSendJob(job);
    job.reject(error);
  }
  afterSendSettled(lane);
}

/**
 * 占用车道在途位并将任务置为 `active`，发起底层出站调用并挂载成功/失败结算回调。
 * @param lane 任务所属的发送车道。
 * @param job 占用车道在途位并发起实际调用的发送任务。
 */
function startSendJob(lane: TelegramSendLane, job: TelegramOutboundJob): void {
  lane.inFlight = job;
  job.state = "active";
  let request: Promise<unknown>;
  try {
    request = job.call(job.signal);
  } catch (error: unknown) {
    handleSendFailure(lane, job, toErrorOr(error, "Telegram outbound call threw."));
    return;
  }
  void request.then(
    (response: unknown): void => handleSendResponse(lane, job, response),
    (error: unknown): void => handleSendFailure(lane, job, error)
  );
}

/**
 * 推进一条车道：队首额度齐备就扣额度并发出，否则按最先解除的约束挂车道定时器或进全局轮转。
 * fromRing 为 true 时由全局轮转调用，不再让位给其它排队车道。
 * @param lane 待推进的发送车道。
 * @param fromRing 是否由全局轮转唤醒调用。
 */
function pumpSendLane(lane: TelegramSendLane, fromRing: boolean): void {
  if (telegramOutboundGateState.aborting || lane.inFlight !== null || lane.inGlobalRing) return;
  const job: TelegramOutboundJob | null = lane.head;
  const now: number = performance.now();
  if (job === null) {
    retireIdleLane(lane, now);
    return;
  }
  if (now < lane.frozenUntil) {
    armLaneTimer(lane, lane.frozenUntil, now);
    return;
  }
  const readyAt: number = chatReadyAt(lane, job.sendCost, now);
  if (readyAt > now) {
    armLaneTimer(lane, readyAt, now);
    return;
  }
  if ((!fromRing && sendGlobalRing.size > 0) || globalReadyAt(job.sendCost, now) > now) {
    joinGlobalRing(lane, now);
    return;
  }
  clearLaneTimer(lane);
  consumeQuota(lane, job.sendCost, now);
  removeQueued(lane, job);
  if (job.fromRetryQueue) {
    job.fromRetryQueue = false;
    countRetryPending(-1);
    countActive(1);
  }
  startSendJob(lane, job);
}

/**
 * 接纳一条发送类请求：按 payload.chat_id 归入聊天车道并计入出站计数，额度齐备时同步发出。
 * 单聊天或全局排队已满时以 TelegramSendQueueFullError 拒绝，不计数。调用方在构造任务的同一
 * 同步片段里已判过接纳状态与信号。
 * @param job 待接纳的发送任务。
 * @param method Bot API 方法名。
 * @param payload 请求载荷。
 */
export function admitSendJob(job: TelegramOutboundJob, method: keyof RawApi, payload: unknown): void {
  const lane: TelegramSendLane = laneForKey(
    sendChatKeyOf((payload as { chat_id?: unknown } | null | undefined)?.chat_id),
    performance.now()
  );
  const laneMax: number = lane.groupClass ? TELEGRAM_MESSAGE_GROUP_PENDING_MAX : TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX;
  if (lane.queued >= laneMax || sendSchedulerState.queuedTotal >= TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX) {
    detachAbortListener(job);
    job.state = "settled";
    job.reject(new TelegramSendQueueFullError(lane.queued >= laneMax ? "chat" : "global"));
    if (lane.head === null && lane.inFlight === null) retireIdleLane(lane, performance.now());
    return;
  }
  job.sendLane = lane;
  job.sendCost = sendCostOf(method, payload);
  countActive(1);
  telegramOutboundGateState.activeJobs.add(job);
  appendQueued(lane, job);
  pumpSendLane(lane, false);
}

/**
 * 取消一条已接纳的发送任务（sendQueued 或 active）：排队中按双向指针直接出队、不扣额度；在途的立即
 * 结算给调用方，车道在途位保留到网络结算。全局取消进行中不推进车道。
 * @param job 待取消的发送任务。
 */
export function abortSendJob(job: TelegramOutboundJob): void {
  const lane: TelegramSendLane | null = job.sendLane;
  if (job.state === "settled" || lane === null) return;
  if (job.state === "sendQueued") {
    removeQueued(lane, job);
    if (lane.head === null) leaveGlobalRing(lane);
  }
  settleSendJob(job);
  job.reject(jobAbortReason(job.signal));
  if (isLaneLive(lane)) pumpSendLane(lane, false);
  settleDrainWaitersIfIdle();
}

/**
 * 清空调度器：全部车道定时器、全局定时器、轮转队列与额度窗口。出站生命周期全局取消（任务
 * 已由各自的 abort 监听结算）与重新初始化时调用；在途请求之后结算时找不到车道，不再推进。
 */
export function resetSendScheduler(): void {
  for (const lane of sendChatLanes.values()) clearLaneTimer(lane);
  sendChatLanes.clear();
  sendGlobalRing.clear();
  if (sendSchedulerState.globalTimer !== null) clearTimeout(sendSchedulerState.globalTimer);
  sendSchedulerState.globalTimer = null;
  sendSchedulerState.queuedTotal = 0;
  sendGlobalWindow.clear();
}
