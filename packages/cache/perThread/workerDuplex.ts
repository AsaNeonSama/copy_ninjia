/** owner: perThread。业务 Worker 向主线程发起双工请求的逐线程运行态（packages/libs/workerDuplex.ts）。 */

import type { WorkerDuplexOutbound } from "../../types/workerDuplex";

/** 单个跨线程双工请求的等待者记录。 */
export interface WorkerDuplexWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

/** 当前 Worker isolate 尚未收到主线程回执的请求等待表（requestId -> WorkerDuplexWaiter）：发出请求时登记，收到回执、signal 中止或 resetWorkerDuplex 时结算并删除；容量受各 Worker 业务并发上限与主线程 Telegram 总闸约束，不淘汰，Worker 重建后从空表开始。 */
export const workerDuplexWaiters: Map<number, WorkerDuplexWaiter> = new Map();

/** 当前 Worker isolate 的双工请求单调递增编号发号器：每次请求自增，Worker 重建后从零开始；单例标量。 */
export const workerDuplexRequestCounter: { current: number } = { current: 0 };

/** 当前 Worker 业务生命周期的默认请求取消信号单例：启动时注入，停机排空收尾可临时置空，resetWorkerDuplex 时清空为 null；Worker 重建后从 null 开始。 */
export const workerDuplexRequestSignal: { current: AbortSignal | null } = { current: null };

/** 当前 Worker isolate 的 postMessage 发送函数单例：启动时注入，resetWorkerDuplex 时清空为 null；Worker 重建后从 null 重新注入。 */
export const workerDuplexPoster: {
  current: ((
    message: WorkerDuplexOutbound<unknown>,
    transfer?: Bun.Transferable[]
  ) => void) | null;
} = { current: null };
