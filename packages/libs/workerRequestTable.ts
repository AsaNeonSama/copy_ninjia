/**
 * 主线程向 Worker 发起、按 requestId 等回执的请求表：心情查询/重抽、群失效、语音合成、摘要组稿
 * 与 Disk I/O 逐请求通道共用。等待者先登记后投递（同步回执也不会丢，同 libs/flushBarrier.ts 的
 * 顺序约定），结算路径为回执、超时、调用方取消、投递被拒与 Worker 崩溃重建 / 放弃 / 终止，一律经 resolve 交回
 * 调用方给定的结果，不 reject。等待表实例由调用方的 cache 模块持有。
 */

import type { WorkerRequestTable, WorkerRequestWaiter } from "../types/workerRequest";

/**
 * 摘除并收尾一个等待者；已结算或未知的 requestId 返回 undefined。
 * @param table 请求等待表。
 * @param requestId 请求序号。
 * @returns 被摘除的等待者；未命中时返回 `undefined`。
 */
function takeWorkerRequest<T, Tag extends string = never>(
  table: WorkerRequestTable<T, Tag>,
  requestId: number
): WorkerRequestWaiter<T, Tag> | undefined {
  const waiter: WorkerRequestWaiter<T, Tag> | undefined = table.waiters.get(requestId);
  if (waiter === undefined) return undefined;
  table.waiters.delete(requestId);
  clearTimeout(waiter.timer);
  if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  return waiter;
}

/** 调用方取消源与取消时交回的结果。 */
export interface WorkerRequestAbort<T> {
  /** 调用前已中止由调用方先行判定，这里只监听之后的中止。 */
  readonly signal: AbortSignal | undefined;
  /** 取消触发时交回给调用方的兜底结果。 */
  readonly result: T;
}

/** beginWorkerRequest 的入参。 */
export interface BeginWorkerRequestOptions<T, Tag extends string = never> {
  /** 持有单调递增序号与在途等待者映射的请求表。 */
  readonly table: WorkerRequestTable<T, Tag>;
  /** 单次请求的超时毫秒数。 */
  readonly timeoutMs: number;
  /** 投递带 requestId 的请求；返回 false 或同步抛错表示投递被拒，按 rejected 结算。 */
  readonly post: (requestId: number) => boolean;
  /** post 同步抛错时的诊断出口：先把异常交给它，再按 rejected 结算。 */
  readonly onPostError: (error: unknown) => void;
  /** 超时或取消后撤回 Worker 侧的工作；不需要撤回时省略。 */
  readonly cancel?: (requestId: number) => void;
  /** 调用方取消；请求不可取消时省略。 */
  readonly abort?: WorkerRequestAbort<T>;
  /** 预期匹配的回执事件类型标签；共用同一等待表且需校对事件类型时传入。 */
  readonly expectedTag?: Tag;
  /** 超时到期时交回的结果。 */
  readonly timedOut: T;
  /** 投递被拒或同步抛错时交回的结果。 */
  readonly rejected: T;
}

/**
 * 登记一个等待者并投递请求，返回在任一结算路径兑现的 Promise。
 * @param options 请求登记、投递、超时与取消配置。
 * @returns 在回执、超时、取消、拒投或全表失败时兑现的结果。
 */
export function beginWorkerRequest<T, Tag extends string = never>({
  table,
  timeoutMs,
  post,
  onPostError,
  cancel,
  abort,
  expectedTag,
  timedOut,
  rejected,
}: BeginWorkerRequestOptions<T, Tag>): Promise<T> {
  return new Promise((resolve: (result: T) => void): void => {
    const requestId: number = ++table.counter.current;
    const withdraw = (result: T): void => {
      const waiter: WorkerRequestWaiter<T, Tag> | undefined = takeWorkerRequest(table, requestId);
      if (waiter === undefined) return;
      try {
        cancel?.(requestId);
      } finally {
        waiter.resolve(result);
      }
    };
    const signal: AbortSignal | undefined = abort?.signal;
    const onAbort: (() => void) | undefined = abort === undefined || signal === undefined
      ? undefined
      : (): void => withdraw(abort.result);
    table.waiters.set(requestId, {
      resolve,
      timer: setTimeout((): void => withdraw(timedOut), timeoutMs),
      signal,
      onAbort,
      expectedTag,
    });
    if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
    let posted: boolean;
    try {
      posted = post(requestId);
    } catch (error: unknown) {
      try {
        onPostError(error);
      } finally {
        takeWorkerRequest(table, requestId)?.resolve(rejected);
      }
      return;
    }
    if (!posted) takeWorkerRequest(table, requestId)?.resolve(rejected);
  });
}

/** settleTaggedWorkerRequest 的入参。 */
export interface SettleTaggedWorkerRequestOptions<T, Tag extends string> {
  /** 持有在途等待者的请求等待表。 */
  readonly table: WorkerRequestTable<T, Tag>;
  /** 回执对应的请求序号。 */
  readonly requestId: number;
  /** 实际收到的回执事件类型标签。 */
  readonly tag: Tag;
  /** 标签校验通过时交回给等待者的结算结果。 */
  readonly result: T;
  /** 实际标签与预期标签不一致时构造拒绝结局的回调。 */
  readonly onMismatch: (expected: Tag, actual: Tag) => T;
}

/**
 * 回执：按 `requestId` 结算并核对预期事件类型标签；不符时改用 `onMismatch` 构造协议错误结果。
 * @param options 请求表、请求序号、事件类型标签与正常/失配结局配置。
 */
export function settleTaggedWorkerRequest<T, Tag extends string>({
  table,
  requestId,
  tag,
  result,
  onMismatch,
}: SettleTaggedWorkerRequestOptions<T, Tag>): void {
  const waiter: WorkerRequestWaiter<T, Tag> | undefined = takeWorkerRequest(table, requestId);
  if (waiter === undefined) return;
  if (waiter.expectedTag !== undefined && waiter.expectedTag !== tag) {
    waiter.resolve(onMismatch(waiter.expectedTag, tag));
    return;
  }
  waiter.resolve(result);
}

/**
 * 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。
 * @param table 请求等待表。
 * @param requestId 回执对应的请求序号。
 * @param result Worker 交回的结算结果。
 */
export function settleWorkerRequest<T, Tag extends string = never>(
  table: WorkerRequestTable<T, Tag>,
  requestId: number,
  result: T
): void {
  takeWorkerRequest(table, requestId)?.resolve(result);
}

/**
 * Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按同一结果结算。
 * @param table 请求等待表。
 * @param result 统一交回给所有在途等待者的兜底结果。
 */
export function failAllWorkerRequests<T, Tag extends string = never>(
  table: WorkerRequestTable<T, Tag>,
  result: T
): void {
  for (const requestId of table.waiters.keys()) {
    takeWorkerRequest(table, requestId)?.resolve(result);
  }
}
