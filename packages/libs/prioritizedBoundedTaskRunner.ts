import { LinkedQueue } from "./linkedQueue";

/** 有界执行器的两档优先级；交互请求优先，后台维护仍按受控比例获得执行机会。 */
export type TaskPriority = "interactive" | "background";

/**
 * 带交互优先级的进程内有界异步执行器。等待上限按两档队列合计计算；后台另有
 * 更小的占用上限 maxBackgroundPending。
 */
export interface PrioritizedBoundedTaskRunner {
  readonly activeCount: number;
  readonly pendingCount: number;
  readonly backgroundPendingCount: number;
  readonly run: <T>(
    priority: TaskPriority,
    task: () => Promise<T>,
    signal?: AbortSignal
  ) => Promise<T | undefined>;
}

/** 创建优先级执行器的容量与公平参数。 */
export interface PrioritizedBoundedTaskRunnerOptions {
  /** 同时在途执行的最大任务数（正安全整数）。 */
  readonly maxConcurrent: number;
  /** 交互与后台两档队列合计允许排队等待的最大任务数（非负安全整数）。 */
  readonly maxPending: number;
  /** 后台队列单独允许排队等待的最大任务数（不超过 maxPending 的非负安全整数）。 */
  readonly maxBackgroundPending: number;
  /** 后台有待执行任务时，连续让行给交互任务的最大突发次数（正安全整数）。 */
  readonly interactiveBurst: number;
}

/**
 * 创建带交互优先级、公平突发和总等待硬顶的异步执行器。
 * @param options 并发上限、排队总上限、后台排队上限与交互突发配额。
 * @returns 新建的优先级有界异步任务执行器。
 */
export function createPrioritizedBoundedTaskRunner({
  maxConcurrent,
  maxPending,
  maxBackgroundPending,
  interactiveBurst,
}: PrioritizedBoundedTaskRunnerOptions): PrioritizedBoundedTaskRunner {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError("maxConcurrent must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new RangeError("maxPending must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(maxBackgroundPending) ||
    maxBackgroundPending < 0 ||
    maxBackgroundPending > maxPending
  ) {
    throw new RangeError("maxBackgroundPending must be a safe integer within maxPending");
  }
  if (!Number.isSafeInteger(interactiveBurst) || interactiveBurst <= 0) {
    throw new RangeError("interactiveBurst must be a positive safe integer");
  }

  let activeCount: number = 0;
  let interactiveStarts: number = 0;
  const interactivePending: LinkedQueue<() => void> = new LinkedQueue<() => void>();
  const backgroundPending: LinkedQueue<() => void> = new LinkedQueue<() => void>();

  function takePending(): (() => void) | undefined {
    if (
      backgroundPending.size > 0 &&
      (interactivePending.size === 0 || interactiveStarts >= interactiveBurst)
    ) {
      interactiveStarts = 0;
      return backgroundPending.shift();
    }
    const interactive: (() => void) | undefined = interactivePending.shift();
    if (interactive !== undefined) {
      interactiveStarts += 1;
      return interactive;
    }
    interactiveStarts = 0;
    return backgroundPending.shift();
  }

  function start<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    activeCount += 1;
    return Promise.resolve()
      .then((): Promise<T> | undefined => {
        return signal?.aborted === true ? undefined : task();
      })
      .finally((): void => {
        activeCount -= 1;
        takePending()?.();
      });
  }

  return {
    get activeCount(): number {
      return activeCount;
    },
    get pendingCount(): number {
      return interactivePending.size + backgroundPending.size;
    },
    get backgroundPendingCount(): number {
      return backgroundPending.size;
    },
    run<T>(
      priority: TaskPriority,
      task: () => Promise<T>,
      signal?: AbortSignal
    ): Promise<T | undefined> {
      if (signal?.aborted === true) return Promise.resolve(undefined);
      if (activeCount < maxConcurrent) return start(task, signal);
      const pendingCount: number = interactivePending.size + backgroundPending.size;
      if (
        pendingCount >= maxPending ||
        (priority === "background" && backgroundPending.size >= maxBackgroundPending)
      ) return Promise.resolve(undefined);
      return new Promise<T | undefined>((
        resolve: (value: T | undefined | PromiseLike<T | undefined>) => void,
        reject: (reason?: unknown) => void
      ): void => {
        const queue: LinkedQueue<() => void> = priority === "interactive"
          ? interactivePending
          : backgroundPending;
        let queued: boolean = true;

        function resume(): void {
          if (!queued) return;
          queued = false;
          signal?.removeEventListener("abort", onAbort);
          void start(task, signal).then(resolve, reject);
        }

        function onAbort(): void {
          if (!queued || !queue.removeValue(resume)) return;
          queued = false;
          signal?.removeEventListener("abort", onAbort);
          resolve(undefined);
        }

        // 入口处已对已 abort 的 signal 提前返回，到这里没有跨过 await，
        // 注册后无需再复查 aborted。
        queue.push(resume);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
