/**
 * Mini App 前端请求取消信号辅助函数。
 */

/**
 * 判断可选 `AbortSignal` 当前是否已进入中止状态。
 *
 * @param signal 可选 `AbortSignal`
 * @returns 已中止时返回 `true`
 */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 在请求取消信号已触发时抛出标准 `AbortError`，阻断在途异步流程继续派发或提交陈旧结果。
 *
 * @param signal 可选 `AbortSignal`
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
