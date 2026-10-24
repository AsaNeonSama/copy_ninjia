/**
 * 主线程非消息类 Telegram 出站请求的 429 退避车道、渐进恢复与活跃任务结算。
 * @see ../../../docs/cn/04-invariants.md
 */

import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../cache/main/telegram";
import {
  TELEGRAM_429_RECOVERY_MAX_CONCURRENT,
  TELEGRAM_TIMER_MAX_DELAY_MS,
} from "../../consts/telegram";
import { toErrorOr } from "../../libs/errorMessage";
import type {
  TelegramOutboundJob,
  TelegramRetryCategory,
  TelegramRetryLane,
} from "../../types/telegramOutbound";
import { logger } from "../logger";
import {
  enqueueRetryJob,
  laneFor,
  removeRetryJob,
  takeRetryHead,
} from "./outboundQueue";
import {
  telegramRetryAfterMilliseconds,
  TelegramRetryQueueFullError,
} from "./outboundRetryPolicy";
import {
  detachAbortListener,
  jobAbortReason,
  releaseResponseBody,
  settleDrainWaitersIfIdle,
} from "./outboundSettle";
import { abortSendJob } from "./sendScheduler";

/**
 * 为指定退避类别挂起下一次恢复唤醒定时器。
 * @param category 退避类别。
 * @param lane 该类别对应的退避车道。
 */
function scheduleRetryTimer(
  category: TelegramRetryCategory,
  lane: TelegramRetryLane
): void {
  const remainingMs: number = Math.max(
    0,
    Math.ceil(lane.retryAt - performance.now())
  );
  const delayMs: number = Math.min(remainingMs, TELEGRAM_TIMER_MAX_DELAY_MS);
  const timer: ReturnType<typeof setTimeout> = setTimeout(
    onRetryTimer,
    delayMs,
    category
  );
  timer.unref();
  lane.retryTimer = timer;
}

/**
 * 退避定时器到期回调：未达截止时刻则续挂，否则进入恢复阶段并推进车道。
 * @param category 到期的退避类别。
 */
function onRetryTimer(category: TelegramRetryCategory): void {
  const lane: TelegramRetryLane = laneFor(category);
  lane.retryTimer = null;
  if (telegramOutboundAbortController.current.signal.aborted) {
    lane.retryAt = 0;
    lane.recovering = false;
    lane.recoveryLimit = 1;
    settleDrainWaitersIfIdle();
    return;
  }
  if (lane.retryAt > performance.now()) {
    scheduleRetryTimer(category, lane);
    return;
  }
  lane.retryAt = 0;
  lane.recovering = true;
  pumpRetryLane(lane);
}

/**
 * 按真实限流响应设定或延长类别的退避截止；不晚于已排期截止的响应不改状态。开始一段新的
 * 等待（此前没有排期中的退避 timer）时记一条 warn，等待期间的后续限流响应不重复记录。
 * @param category 命中 429 的退避类别。
 * @param retryAfterMs 本次响应要求的退避毫秒数。
 */
function extendRetry(
  category: TelegramRetryCategory,
  retryAfterMs: number
): void {
  const lane: TelegramRetryLane = laneFor(category);
  const retryAt: number = performance.now() + retryAfterMs;
  if (
    lane.retryTimer !== null &&
    retryAt <= lane.retryAt
  ) return;
  if (lane.retryTimer === null) {
    logger.warn(`Telegram ${category} requests hit 429; backing off for ${retryAfterMs} ms.`);
  }
  lane.retryAt = retryAt;
  lane.recovering = true;
  lane.recoveryLimit = 1;
  if (lane.retryTimer !== null) {
    clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
  }
  scheduleRetryTimer(category, lane);
}

/**
 * 从活跃集合摘除任务并扣减全局与车道活跃计数。
 * @param job 待释放的活跃出站任务。
 * @returns 该任务所属的退避车道。
 */
function releaseActiveJob(job: TelegramOutboundJob): TelegramRetryLane {
  const lane: TelegramRetryLane = laneFor(job.category);
  telegramOutboundGateState.activeJobs.delete(job);
  telegramOutboundGateState.activeCount--;
  lane.activeCount--;
  if (job.fromRetryQueue) {
    lane.recoveryActive--;
    job.fromRetryQueue = false;
  }
  return lane;
}

/**
 * 车道无排队且无恢复中在途任务时重置渐进恢复状态。
 * @param lane 待检查的退避车道。
 */
export function resetRecoveryIfIdle(lane: TelegramRetryLane): void {
  if (
    lane.head !== null ||
    lane.recoveryActive !== 0
  ) return;
  if (lane.retryTimer !== null) {
    if (
      telegramOutboundAccepting.current &&
      !telegramOutboundAbortController.current.signal.aborted
    ) return;
    clearTimeout(lane.retryTimer);
    lane.retryTimer = null;
  }
  lane.retryAt = 0;
  lane.recovering = false;
  lane.recoveryLimit = 1;
}

/**
 * 结算一个仍然 active 的任务。调用方 handleActiveResponse 已在同一个同步
 * 片段里确认过状态，这里不再复判；非 active 的响应由 handleActiveResponse
 * 统一释放 body。
 * @param job 仍处于 active 状态的出站任务。
 * @param response 要交给调用方的响应。
 */
function resolveActiveJob(job: TelegramOutboundJob, response: unknown): void {
  const wasRecovery: boolean = job.fromRetryQueue;
  const lane: TelegramRetryLane = releaseActiveJob(job);
  job.state = "settled";
  detachAbortListener(job);
  job.resolve(response);
  if (
    wasRecovery &&
    lane.retryTimer === null &&
    lane.recoveryLimit < TELEGRAM_429_RECOVERY_MAX_CONCURRENT
  ) lane.recoveryLimit++;
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 以失败结算一个仍处于 active 状态的出站任务，并推进同车道恢复与排空检查。
 * @param job 待结算的活跃任务。
 * @param error 失败原因。
 */
function rejectActiveJob(job: TelegramOutboundJob, error: unknown): void {
  if (job.state !== "active") return;
  const lane: TelegramRetryLane = releaseActiveJob(job);
  job.state = "settled";
  detachAbortListener(job);
  job.reject(error);
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 从任一阶段只结算一次取消；非发送类只有 active/retryQueued 占着队列或并发计数，已接纳的
 * 发送类交给发送调度器。交给调用方的错误按 jobAbortReason 区分超时与取消。
 * @param job 待取消的出站任务。
 */
export function abortJob(job: TelegramOutboundJob): void {
  if (job.sendLane !== null) {
    abortSendJob(job);
    return;
  }
  if (job.state === "settled") return;
  const lane: TelegramRetryLane = laneFor(job.category);
  if (job.state === "retryQueued") removeRetryJob(job);
  else if (job.state === "active") releaseActiveJob(job);
  job.state = "settled";
  detachAbortListener(job);
  job.reject(jobAbortReason(job.signal));
  if (!telegramOutboundGateState.aborting) pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 处理活跃任务的返回响应：非 429 直接兑现，命中 429 则按队列容量与取消状态重排或结算。
 * @param job 收到响应的出站任务。
 * @param response 下游调用返回的响应对象。
 */
function handleActiveResponse(job: TelegramOutboundJob, response: unknown): void {
  if (job.state !== "active") {
    releaseResponseBody(response);
    return;
  }
  const retryAfterMs: number | undefined = telegramRetryAfterMilliseconds(response);
  if (retryAfterMs === undefined) {
    resolveActiveJob(job, response);
    return;
  }
  const lane: TelegramRetryLane = releaseActiveJob(job);
  if (job.signal.aborted) {
    // 调用方在限流响应返回的同时取消：不重排也不交给调用方，在此释放 body。
    releaseResponseBody(response);
    job.state = "settled";
    detachAbortListener(job);
    job.reject(jobAbortReason(job.signal));
  } else if (enqueueRetryJob(job)) {
    // 按接纳序号回到原有 FIFO 位置，下一次尝试取新响应，本次响应丢弃。
    releaseResponseBody(response);
  } else {
    // 队列已满：原样把限流响应交给调用方，body 所有权随之转移，这里不释放。
    job.state = "settled";
    detachAbortListener(job);
    job.resolve(response);
  }
  extendRetry(job.category, retryAfterMs);
  pumpRetryLane(lane);
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 发起活跃任务的单次下游请求并挂接响应与异常回调。
 * @param job 待执行的活跃出站任务。
 */
function executeActiveJob(job: TelegramOutboundJob): void {
  if (job.state !== "active") return;
  let request: Promise<unknown>;
  try {
    request = job.call(job.signal);
  } catch (error: unknown) {
    rejectActiveJob(job, toErrorOr(error, "Telegram outbound call threw."));
    return;
  }
  void request.then(
    (response: unknown): void => handleActiveResponse(job, response),
    (error: unknown): void => rejectActiveJob(job, error)
  );
}

/**
 * 把任务切成 active 并发起尝试。两个调用方（enqueueOrStart、pumpRetryLane）都在同一个
 * 同步片段里确认过 job 信号未取消，这里不复判；之后的取消由 abort 监听结算。
 * @param job 待启动的出站任务。
 * @param fromRetryQueue 是否从 429 退避队列取出。
 */
function startJob(job: TelegramOutboundJob, fromRetryQueue: boolean): void {
  const lane: TelegramRetryLane = laneFor(job.category);
  job.state = "active";
  job.fromRetryQueue = fromRetryQueue;
  telegramOutboundGateState.activeCount++;
  lane.activeCount++;
  telegramOutboundGateState.activeJobs.add(job);
  if (fromRetryQueue) lane.recoveryActive++;
  if (fromRetryQueue && job.beforeRetry !== undefined) {
    let precondition: Promise<void>;
    try {
      precondition = job.beforeRetry();
    } catch (error: unknown) {
      rejectActiveJob(job, error);
      return;
    }
    void precondition.then(
      (): void => executeActiveJob(job),
      (error: unknown): void => rejectActiveJob(job, error)
    );
    return;
  }
  executeActiveJob(job);
}

/**
 * 在恢复并发上限内从退避车道队首依次取出任务并发起重试。
 * @param lane 待推进的退避车道。
 */
function pumpRetryLane(lane: TelegramRetryLane): void {
  if (telegramOutboundGateState.aborting) return;
  if (lane.retryTimer !== null || !lane.recovering) return;
  while (lane.recoveryActive < lane.recoveryLimit) {
    const job: TelegramOutboundJob | null = takeRetryHead(lane);
    if (job === null) break;
    if (job.signal.aborted) {
      job.state = "settled";
      detachAbortListener(job);
      job.reject(jobAbortReason(job.signal));
      continue;
    }
    startJob(job, true);
  }
  resetRecoveryIfIdle(lane);
  settleDrainWaitersIfIdle();
}

/**
 * 新接纳的任务：所在类别正在退避或已有积压时按接纳序号排进退避 FIFO，否则直接开始。
 * 调用方（runTelegramCategorizedRequestInternal、telegramOutboundGate）在构造 job 前的
 * 同一个同步片段里已判过接纳状态与信号，这里不复判。
 * @param job 新接纳的出站任务。
 */
export function enqueueOrStart(job: TelegramOutboundJob): void {
  const lane: TelegramRetryLane = laneFor(job.category);
  if (
    lane.retryTimer !== null ||
    lane.recovering ||
    lane.head !== null
  ) {
    if (enqueueRetryJob(job)) return;
    detachAbortListener(job);
    job.state = "settled";
    job.reject(new TelegramRetryQueueFullError());
    return;
  }
  startJob(job, false);
}
