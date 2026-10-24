/**
 * 只保留「当前正在处理的值 + 最新待处理值」的异步写入器。
 *
 * 中间快照被合并：正在写的不能撤销，写入期间到达的更新只保留最后一份。
 */
export interface LatestValueRunner<T> {
  readonly push: (value: T) => Promise<void>;
}

/**
 * 构造只保留在途值与最新待处理值的合并异步执行器。
 * @param consume 消费单份最新快照值的异步处理函数。
 * @returns 具备合并排队能力的 LatestValueRunner 实例。
 */
export function createLatestValueRunner<T>(consume: (value: T) => Promise<void>): LatestValueRunner<T> {
  let pendingValue: T | undefined;
  let hasPendingValue: boolean = false;
  let running: Promise<void> | null = null;
  // drain 尚未自行收尾的标记；push 据此判断 drain 是否一路同步跑完。
  let draining: boolean = false;

  const drain = async (): Promise<void> => {
    let latestError: unknown;
    let latestFailed: boolean = false;
    while (hasPendingValue) {
      const current: T = pendingValue as T;
      pendingValue = undefined;
      hasPendingValue = false;
      try {
        await consume(current);
        // 中间旧值失败、更新的值成功时，最新状态已经持久化，整批结算为成功。
        latestError = undefined;
        latestFailed = false;
      } catch (error: unknown) {
        // 单次失败后继续排空，最终只以最新一次实际消费的结果结算。
        latestError = error;
        latestFailed = true;
      }
    }
    // 在 drain 自己返回前同步清空，不放在 promise.finally 里。
    draining = false;
    running = null;
    if (latestFailed) throw latestError;
  };

  return {
    push(value: T): Promise<void> {
      pendingValue = value;
      hasPendingValue = true;
      if (running !== null) return running;
      draining = true;
      const started: Promise<void> = drain();
      // drain 一路同步跑完时（consume 在第一个挂起点之前就抛出），draining 已被置回
      // false：这次 push 已经结算，不把这个 settled promise 挂回 running。
      if (draining) running = started;
      return started;
    },
  };
}
