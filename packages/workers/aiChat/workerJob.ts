/**
 * AI Worker 侧执行主线程可取消任务（语音合成、摘要组稿）的公共骨架：排空期间直接返回不可用失败，
 * 否则登记 requestId 取消控制器并与 Worker 生命周期信号合并，结算后移除登记并发布回执。
 */

import {
  aiChatWorkerAbortController,
  aiChatWorkerQuiescing,
  inFlightAiWorkerJobs,
} from "../../cache/workers/aiChat/worker";
import { AI_WORKER_JOB_UNAVAILABLE } from "../../consts/aiChat/workerJob";
import { logger } from "../../infra/logger";
import { trackInflight } from "../../libs/inflight";
import type { AiWorkerJobFailure } from "../../types/aiChat/workerJob";

/** runAiWorkerJob 的入参。 */
export interface RunAiWorkerJobOptions<T> {
  /** 调用方 owner 的在途表（requestId → 取消控制器）。 */
  readonly jobs: Map<number, AbortController>;
  /** 主线程分配的任务请求序号。 */
  readonly requestId: number;
  /** 执行任务；正常情况应自行把异常折算成结果，若意外 reject 则记错误日志并回执 `AI_WORKER_JOB_UNAVAILABLE`。 */
  readonly run: (signal: AbortSignal) => Promise<T>;
  /** 回执结果给主线程。 */
  readonly publish: (result: T | AiWorkerJobFailure) => void;
}

/**
 * 接纳一次可取消的后台任务：若 Worker 已进入停机排空阶段则立即回执 `AI_WORKER_JOB_UNAVAILABLE`，
 * 否则登记 `AbortController`、纳入 `inFlightAiWorkerJobs` 排空追踪并启动任务，结算后摘除在途条目并回执结果；
 * 若 `run` 意外 reject，摘除登记并记录错误日志后回执 `AI_WORKER_JOB_UNAVAILABLE`。
 *
 * @param options 任务在途登记表、请求序号、执行回调与回执回调
 */
export function runAiWorkerJob<T>({ jobs, requestId, run, publish }: RunAiWorkerJobOptions<T>): void {
  if (aiChatWorkerQuiescing.current) {
    publish(AI_WORKER_JOB_UNAVAILABLE);
    return;
  }
  const controller: AbortController = new AbortController();
  jobs.set(requestId, controller);
  const task: Promise<void> = run(
    AbortSignal.any([controller.signal, aiChatWorkerAbortController.current.signal])
  ).then(
    (result: T): void => {
      if (jobs.get(requestId) === controller) jobs.delete(requestId);
      publish(result);
    },
    (error: unknown): void => {
      if (jobs.get(requestId) === controller) jobs.delete(requestId);
      logger.error("Unexpected error while running an AI worker job:", { requestId }, error);
      publish(AI_WORKER_JOB_UNAVAILABLE);
    }
  );
  void trackInflight(inFlightAiWorkerJobs, task);
}

/**
 * 等待所有已在途的 AI Worker 后台任务全部结算后再推进停机记忆与用量刷盘。
 */
export async function drainAiWorkerJobs(): Promise<void> {
  while (inFlightAiWorkerJobs.size > 0) {
    await Promise.allSettled(inFlightAiWorkerJobs);
  }
}
