/** 单链串行异步任务尾节点句柄，由调用方在 `packages/cache/` 模块中持有。 */
export interface SerialChainHolder {
  /** 当前队列尾部的 Promise；只以成功状态结算，空闲时为已兑现的空 Promise。 */
  current: Promise<void>;
}

/**
 * 链尾吸收任务结果与异常的共用回调。
 * @returns 恒返回 undefined，使链尾 Promise 以成功状态结算。
 */
function ignoreSettled(): undefined {
  return undefined;
}

/**
 * 把任务挂到单链串行队列尾部，在前一项结算后执行；前一项抛错不毒化后续排队任务，
 * 本次任务的结果与异常原样交回调用方。按 key 分组的串行队列见 `./keyedSerialTaskRunner.ts`。
 * 调用方：`infra/identityPolicy/coordination.ts` 的 `runProtectedIdentityMutation`、
 * Mini App 配置保存（`mini-app-api-server/view/configs/storage.ts`）与 TOTP 启用/删除（`mini-app-api-server/auth/totpStorage.ts`）。
 *
 * @param holder 保存当前链尾 Promise 的状态句柄。
 * @param task 需串行执行的同步或异步任务回调。
 * @returns 该次任务的返回值。
 */
export function runSerialChain<T>(
  holder: SerialChainHolder,
  task: () => T | Promise<T>
): Promise<T> {
  const result: Promise<T> = holder.current.then(task);
  holder.current = result.then(ignoreSettled, ignoreSettled);
  return result;
}
