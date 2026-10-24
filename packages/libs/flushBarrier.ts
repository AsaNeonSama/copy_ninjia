import type { FlushResult } from "../types/lifecycle";

interface PendingFlush<TDetail> {
  resolve: (result: FlushResult) => void;
  onDetail: ((detail: TDetail | undefined) => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
}

export interface FlushBarrier<TDetail = undefined> {
  /** 建立一次等待；post 返回 false 或同步抛错时立即按 failed 结算。 */
  readonly begin: (
    post: (id: number) => boolean | void,
    timeoutMs?: number,
    onDetail?: (detail: TDetail | undefined) => void
  ) => Promise<FlushResult>;
  /** 结算指定回执；迟到或重复回执返回 false 且不产生副作用。 */
  readonly settle: (id: number, result: FlushResult, detail?: TDetail) => boolean;
  /** Worker 崩溃/终止时一次性结算所有在途等待。 */
  readonly settleAll: (result: FlushResult) => void;
  /** 仅供故障日志和测试观察，不暴露 resolver 所有权。 */
  readonly pendingCount: () => number;
}

export interface CreateFlushBarrierParams {
  /** 单次 flush 握手的默认超时毫秒预算。 */
  timeoutMs: number;
}

/**
 * Worker flush / mailbox barrier 的统一握手原语。等待项在 post 之前登记，
 * 同步回执同样可结算；所有完成路径都先从 Map 删除并清 timer，再向等待方转交可选
 * 回执细节并 resolve，超时、迟到回执与崩溃结算之间只结算一次。
 * @param options 屏障实例的默认超时配置。
 * @returns 新建的 FlushBarrier 握手控制器。
 */
export function createFlushBarrier<TDetail = undefined>(options: CreateFlushBarrierParams): FlushBarrier<TDetail> {
  const pending: Map<number, PendingFlush<TDetail>> = new Map();
  let nextId: number = 1;

  function settle(id: number, result: FlushResult, detail?: TDetail): boolean {
    const entry: PendingFlush<TDetail> | undefined = pending.get(id);
    if (entry === undefined) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.onDetail?.(detail);
    entry.resolve(result);
    return true;
  }

  return {
    begin: (
      post: (id: number) => boolean | void,
      timeoutMs: number | undefined = options.timeoutMs,
      onDetail?: (detail: TDetail | undefined) => void
    ): Promise<FlushResult> => {
      const id: number = nextId++;
      return new Promise((resolve: (value: FlushResult | PromiseLike<FlushResult>) => void): void => {
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          settle(id, "timedOut");
        }, timeoutMs);
        pending.set(id, { resolve, onDetail, timer });
        try {
          if (post(id) === false) settle(id, "failed");
        } catch {
          settle(id, "failed");
        }
      });
    },
    settle,
    settleAll: (result: FlushResult): void => {
      // 按进入时的在途 id 快照逐个结算；onDetail 回调期间新登记的等待不在本次结算范围内。
      for (const id of [...pending.keys()]) settle(id, result);
    },
    pendingCount: (): number => pending.size,
  };
}
