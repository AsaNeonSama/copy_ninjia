/**
 * 主线程向 AI Worker 发起可取消任务的公共请求骨架。
 */

import { AI_WORKER_JOB_ABORTED, AI_WORKER_JOB_TIMED_OUT, AI_WORKER_JOB_UNAVAILABLE } from "../consts/aiChat/workerJob";
import { beginWorkerRequest } from "../libs/workerRequestTable";
import { logger } from "../infra/logger";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { AiWorkerJobFailure, AiWorkerJobTransport } from "../types/aiChat/workerJob";
import type { WorkerRequestTable } from "../types/workerRequest";

/** requestAiWorkerJob 的入参。 */
export interface RequestAiWorkerJobOptions<T> {
  /** 存放本类在途请求的等待表。 */
  readonly table: WorkerRequestTable<T | AiWorkerJobFailure>;
  /** 请求超时时间（毫秒）。 */
  readonly timeoutMs: number;
  /** 向 AI Worker 投递消息的传输通道与可用性状态。 */
  readonly transport: AiWorkerJobTransport;
  /** 调用方取消信号。 */
  readonly signal: AbortSignal | undefined;
  /** 用分配到的 requestId 构造开始消息。 */
  readonly start: (requestId: number) => AiChatWorkerMessage;
  /** 用同一 requestId 构造取消消息。 */
  readonly cancel: (requestId: number) => AiChatWorkerMessage;
}

/**
 * 发起一次可取消任务并等待结果。
 * @param options 可取消 Worker 任务请求配置参数。
 * @returns Worker 任务成功结果或统一失败原因。
 */
export function requestAiWorkerJob<T>({
  table,
  timeoutMs,
  transport,
  signal,
  start,
  cancel,
}: RequestAiWorkerJobOptions<T>): Promise<T | AiWorkerJobFailure> {
  if (!transport.workerAvailable) return Promise.resolve(AI_WORKER_JOB_UNAVAILABLE);
  if (signal?.aborted === true) return Promise.resolve(AI_WORKER_JOB_ABORTED);
  return beginWorkerRequest<T | AiWorkerJobFailure>({
    table,
    timeoutMs,
    post: (requestId: number): boolean => transport.post(start(requestId)),
    onPostError: (error: unknown): void => {
      logger.error("Failed to post an AI Worker job request:", error);
    },
    cancel: (requestId: number): void => {
      transport.post(cancel(requestId));
    },
    abort: { signal, result: AI_WORKER_JOB_ABORTED },
    timedOut: AI_WORKER_JOB_TIMED_OUT,
    rejected: AI_WORKER_JOB_UNAVAILABLE,
  });
}
