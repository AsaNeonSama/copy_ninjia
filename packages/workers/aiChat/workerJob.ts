/**
 * AI Worker 侧执行主线程可取消任务（语音合成、摘要组稿）的公共骨架：排空期间直接返回不可用失败，
 * 否则登记 requestId 取消控制器并与 Worker 生命周期信号合并，结算后移除登记并发布回执。
 */

import { aiChatWorkerAbortController, aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { AI_WORKER_JOB_UNAVAILABLE } from "../../consts/aiChat/workerJob";
import type { AiWorkerJobFailure } from "../../types/aiChat/workerJob";

/** runAiWorkerJob 的入参。 */
export interface RunAiWorkerJobOptions<T> {
  /** 调用方 owner 的在途表（requestId → 取消控制器）。 */
  readonly jobs: Map<number, AbortController>;
  readonly requestId: number;
  /** 执行任务；必须自行把意外异常折算成结果，返回的 Promise 不得 reject。 */
  readonly run: (signal: AbortSignal) => Promise<T>;
  /** 回执结果给主线程。 */
  readonly publish: (result: T | AiWorkerJobFailure) => void;
}

/** 接纳一次任务；结算后摘除在途条目并回执。 */
export function runAiWorkerJob<T>({ jobs, requestId, run, publish }: RunAiWorkerJobOptions<T>): void {
  if (aiChatWorkerQuiescing.current) {
    publish(AI_WORKER_JOB_UNAVAILABLE);
    return;
  }
  const controller: AbortController = new AbortController();
  jobs.set(requestId, controller);
  void run(AbortSignal.any([controller.signal, aiChatWorkerAbortController.current.signal])).then((result: T): void => {
    if (jobs.get(requestId) === controller) jobs.delete(requestId);
    publish(result);
  });
}
