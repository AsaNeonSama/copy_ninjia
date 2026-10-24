import type { FlushResult, FlushWaiter } from "../types/lifecycle";
import { assertTimeoutMs } from "./inflight";

/** waitForFlush 的入参。 */
export interface WaitForFlushParams {
  /** owner 持有的等待者集合；owner 经 settleFlushWaiters 统一结算。 */
  readonly waiters: Set<FlushWaiter>;
  /** 本次等待的预算。 */
  readonly timeoutMs: number;
  /** 预算耗尽时调用（如打断 owner 的在途工作）；此时本等待者仍在集合里。 */
  readonly onTimeout?: () => void;
}

/**
 * 登记一个带预算的排空等待者并返回它的结论。owner 排空或放弃时经 settleFlushWaiters
 * 结算。预算先耗尽时先调用 onTimeout：它同步引起的结算对本等待者同样生效；仍未结算才
 * 出队并按 `"timedOut"` 结算。已被结算的等待者的 timer 已取消，不会再触发。
 * @param params 等待者集合、超时毫秒预算与可选的超时前钩子。
 * @returns 排空完成或超时结算结论。
 */
export function waitForFlush({ waiters, timeoutMs, onTimeout }: WaitForFlushParams): Promise<FlushResult> {
  return new Promise<FlushResult>((resolve: (result: FlushResult) => void): void => {
    const waiter: FlushWaiter = {
      resolve,
      timer: setTimeout((): void => {
        if (!waiters.has(waiter)) return;
        onTimeout?.();
        if (waiters.delete(waiter)) resolve("timedOut");
      }, timeoutMs),
    };
    waiters.add(waiter);
  });
}

/**
 * 以同一结论结算并清空全部等待者，各自的预算 timer 一并取消。
 * @param waiters 待统一结算并清空的等待者集合。
 * @param result 交付给所有等待者的排空结论。
 */
export function settleFlushWaiters(waiters: Set<FlushWaiter>, result: FlushResult): void {
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }
  waiters.clear();
}

/** drainWithWaiter 的入参。 */
export interface DrainWaiterParams {
  /** owner 名，用于参数校验的错误文案（英文，见 AGENTS.md 日志约定）。 */
  owner: string;
  /** 本次 drain 的预算；0 表示没有等待窗口，负数与非有限值一律拒绝。 */
  timeoutMs: number;
  /** owner 当前是否已无在途任务与待执行任务。 */
  isIdle: () => boolean;
  /** owner 持有的等待者集合；owner 转为空闲时以 `"flushed"` 经 settleFlushWaiters 结算。 */
  waiters: Set<FlushWaiter>;
  /** 触发一次空闲检查，覆盖「登记 waiter」与「owner 恰好转为空闲」之间的缝隙。 */
  notifyIfIdle: () => void;
  /** 预算耗尽时打断在途请求、结算尚未开始的任务。 */
  abort: () => void;
}

/**
 * 停机 drain 的骨架：等待某个 owner 的在途与待执行工作归零，超出预算则 abort 并结算。
 *
 * owner 是头像更新队列（copy/avatarQueue.ts 的 drainAvatarUpdates）与 `/delete_message` 的待删队列
 * （commands/deleteMessage/queue.ts 的 drainTargetMessageDeletions）。
 * 预算为 0 时不抛校验错，立刻 abort 并按 timedOut 结算；登记 waiter 之后再触发一次
 * 空闲检查。
 * @see ../../docs/cn/04-invariants.md
 * @param params owner 标识、超时预算、空闲判定、等待者集合与中止回调。
 * @returns 归零返回 `"flushed"`；预算耗尽时先 abort 再返回 `"timedOut"`。
 */
export function drainWithWaiter({
  owner,
  timeoutMs,
  isIdle,
  waiters,
  notifyIfIdle,
  abort,
}: DrainWaiterParams): Promise<FlushResult> {
  assertTimeoutMs(timeoutMs, `${owner} drain timeout`);
  if (isIdle()) return Promise.resolve("flushed");
  // 预算为 0（异常退出路径）时没有等待窗口：直接 abort 并按 timedOut 结算，不抛校验错误。
  if (timeoutMs === 0) {
    abort();
    return Promise.resolve("timedOut");
  }
  const result: Promise<FlushResult> = waitForFlush({ waiters, timeoutMs, onTimeout: abort });
  notifyIfIdle();
  return result;
}
