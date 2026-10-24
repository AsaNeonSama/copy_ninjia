import {
  workerDuplexPoster,
  workerDuplexRequestCounter,
  workerDuplexRequestSignal,
  workerDuplexWaiters,
} from "../cache/perThread/workerDuplex";
import type {
  WorkerDuplexError,
  WorkerDuplexOutbound,
  WorkerDuplexResponse,
} from "../types/workerDuplex";
import type { WorkerDuplexWaiter } from "../cache/perThread/workerDuplex";
import { isTimeoutAbort } from "./abortSignal";
import { toErrorOr } from "./errorMessage";

/** 主线程能力请求失败后在 Worker 侧重建的安全错误。 */
class WorkerDuplexRemoteError extends Error {
  readonly telegramErrorCode: number | undefined;
  readonly telegramDescription: string | undefined;

  constructor(error: WorkerDuplexError) {
    super(error.message);
    this.name = error.name;
    this.telegramErrorCode = error.telegramErrorCode;
    this.telegramDescription = error.telegramDescription;
  }
}

/**
 * 判断一条 Worker 入站消息是不是双工回执。
 * @param value Worker 收到的入站消息值。
 * @returns 是双工回执信封时返回 `true`。
 */
export function isWorkerDuplexResponse(value: unknown): value is WorkerDuplexResponse {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "response" &&
    "requestId" in value && typeof value.requestId === "number";
}

/**
 * 在 Worker 启动入口注入唯一的 postMessage 出口。
 * @param poster 向主线程发送双工信封的底层函数。
 */
export function initializeWorkerDuplex<TRequest>(
  poster: (
    message: WorkerDuplexOutbound<TRequest>,
    transfer?: Bun.Transferable[]
  ) => void
): void {
  workerDuplexPoster.current = poster as (
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void;
}

/**
 * 配置当前 Worker 此后新建的双工请求所继承的业务生命周期信号。
 * @param signal 当前在途业务的取消信号，无在途业务时传 `null`。
 */
export function setWorkerDuplexRequestSignal(signal: AbortSignal | null): void {
  workerDuplexRequestSignal.current = signal;
}

/**
 * 请求信号中止时本地结算的错误：超时预算耗尽给 TimeoutError，其余取消给 AbortError。
 * @param signal 已触发中止的 `AbortSignal`。
 * @returns 对应的 `DOMException` 错误实例。
 */
function abortError(signal: AbortSignal): Error {
  return isTimeoutAbort(signal)
    ? new DOMException("Worker duplex request timed out.", "TimeoutError")
    : new DOMException("Worker duplex request was aborted.", "AbortError");
}

/**
 * Worker 请求主线程执行一项能力。等待者先登记后 post，同步回执同样可结算；
 * 取消时用独立 cancel 信封撤销主线程排队/在途工作。
 * @param request 发往主线程的能力请求载荷。
 * @param signal 调用方可选的取消信号。
 * @param transfer 随 `postMessage` 转移所有权的 `Transferable` 列表。
 * @returns 主线程能力执行结果的 Promise。
 */
export function requestMainThread<TRequest, TResult>(
  request: TRequest,
  signal?: AbortSignal,
  transfer?: Bun.Transferable[]
): Promise<TResult> {
  const defaultSignal: AbortSignal | null = workerDuplexRequestSignal.current;
  const requestSignal: AbortSignal | undefined = defaultSignal === null
    ? signal
    : signal === undefined || signal === defaultSignal
      ? defaultSignal
      : AbortSignal.any([defaultSignal, signal]);
  if (requestSignal?.aborted === true) return Promise.reject(abortError(requestSignal));
  const poster: ((
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void) | null =
    workerDuplexPoster.current;
  if (poster === null) {
    return Promise.reject(new Error("Worker duplex transport is not initialized."));
  }
  if (workerDuplexRequestCounter.current >= Number.MAX_SAFE_INTEGER) {
    return Promise.reject(new Error("Worker duplex request id exhausted."));
  }
  const requestId: number = ++workerDuplexRequestCounter.current;
  return new Promise<TResult>((
    resolve: (value: TResult | PromiseLike<TResult>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const abortListener: (() => void) | undefined = requestSignal === undefined
      ? undefined
      : (): void => {
        if (!workerDuplexWaiters.delete(requestId)) return;
        try {
          poster({ __duplex: "cancel", requestId });
        } catch {
          // 本地 waiter 已经结算；Worker 退出时由主线程代际 signal 收尾。
        }
        reject(abortError(requestSignal));
      };
    const waiter: WorkerDuplexWaiter = {
      resolve: (value: unknown): void => resolve(value as TResult),
      reject,
      signal: requestSignal,
      abortListener,
    };
    workerDuplexWaiters.set(requestId, waiter);
    if (abortListener !== undefined) {
      requestSignal!.addEventListener("abort", abortListener, { once: true });
    }
    try {
      poster({ __duplex: "request", requestId, request }, transfer);
    } catch (error: unknown) {
      workerDuplexWaiters.delete(requestId);
      if (abortListener !== undefined) {
        requestSignal!.removeEventListener("abort", abortListener);
      }
      reject(toErrorOr(error, "Worker duplex post failed."));
    }
  });
}

/**
 * Worker onmessage 的双工回执分支；已取消请求的迟到回执直接丢弃。
 * @param response 主线程发回的双工回执信封。
 */
export function handleWorkerDuplexResponse(response: WorkerDuplexResponse): void {
  const waiter: WorkerDuplexWaiter | undefined =
    workerDuplexWaiters.get(response.requestId);
  if (waiter === undefined) return;
  workerDuplexWaiters.delete(response.requestId);
  if (waiter.abortListener !== undefined) {
    waiter.signal!.removeEventListener("abort", waiter.abortListener);
  }
  if (response.ok) {
    waiter.resolve(response.value);
  } else {
    waiter.reject(new WorkerDuplexRemoteError(response.error ?? {
      name: "Error",
      message: "Main-thread capability request failed.",
      telegramErrorCode: undefined,
      telegramDescription: undefined,
    }));
  }
}

/**
 * Worker 停止时结算本 isolate 的全部等待者。
 * @param reason 拒绝所有在途等待者的原因文案。
 */
export function resetWorkerDuplex(reason: string): void {
  workerDuplexPoster.current = null;
  workerDuplexRequestSignal.current = null;
  const error: Error = new Error(reason);
  for (const waiter of workerDuplexWaiters.values()) {
    if (waiter.abortListener !== undefined) {
      waiter.signal!.removeEventListener("abort", waiter.abortListener);
    }
    waiter.reject(error);
  }
  workerDuplexWaiters.clear();
}
