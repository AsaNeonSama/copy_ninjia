import {
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
} from "../consts/miniApp";
import { errorMessage } from "../libs/errorMessage";
import type { MiniAppPickerResultEvent } from "../types/miniApp/identities";
import { classifyMiniAppAuthError } from "./authError";
import { miniAppFetchJson } from "./request";

/**
 * 判断可选 `AbortSignal` 当前是否已进入中止状态。
 *
 * @param signal 可选 `AbortSignal`
 * @returns 已中止时返回 `true`
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 在请求取消信号已触发时抛出标准 `AbortError`，避免继续构造或发出陈旧轮询请求。
 *
 * @param signal 可选 `AbortSignal`
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

/**
 * 等待指定毫秒数；若等待前或等待期间 `signal` 触发中止，立即清理定时器并返回 `false`。
 *
 * @param delayMs 等待毫秒数
 * @param signal 可选 `AbortSignal`
 * @returns 完整等待结束返回 `true`，已中止返回 `false`
 */
function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (isAborted(signal)) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve: (completed: boolean) => void): void => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 调用 `GET ./api/picker/result` 查询原生选择器会话的共享结果回执；
 * 若 `signal` 在发出前或响应结算后已中止，直接拒绝为标准 `AbortError`。
 *
 * @param requestId 预备选择器请求 ID
 * @param signal 可选 `AbortSignal`，用于页面卸载或新一轮选择时中止请求
 * @returns 已完成回执；尚未收到时返回 `null`
 */
export async function pollMiniAppPickerResult(
  requestId: number,
  signal?: AbortSignal
): Promise<Readonly<MiniAppPickerResultEvent> | null> {
  throwIfAborted(signal);
  const response: { readonly result: Readonly<MiniAppPickerResultEvent> | null } =
    await miniAppFetchJson(
      `./api/picker/result?requestId=${encodeURIComponent(String(requestId))}`,
      signal !== undefined ? { signal } : undefined
    );
  throwIfAborted(signal);
  return response.result;
}

/**
 * 按固定间隔轮询原生选择器会话回执，直至收到结果、被 `signal` 中止或达到最大尝试次数。
 * 单次查询失败（网络抖动、服务端 5xx 等）不中断轮询；会话缺失、密钥吊销或门禁拒绝错误立即抛出，
 * 由调用方经根 store 的 `notify` 重定向至对应验证/拦截页；最后一轮查询失败时抛出该轮错误。
 * 等待间隔或请求期间 `signal` 触发中止时立即停止轮询并返回 `"aborted"`（不抛出异常）。
 *
 * @param requestId 预备选择器请求 ID
 * @param signal 可选 `AbortSignal`，用于调用方页面卸载或新选择覆盖旧选择时中止轮询
 * @returns 命中回执时返回事件对象，被中止时返回 `"aborted"`，最后一轮查询成功但仍无回执时返回 `"timeout"`
 */
export async function waitForMiniAppPickerResult(
  requestId: number,
  signal?: AbortSignal
): Promise<Readonly<MiniAppPickerResultEvent> | "timeout" | "aborted"> {
  for (
    let attempt: number = 0;
    attempt < MINI_APP_PICKER_POLL_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const waited: boolean = await sleepWithAbort(
      MINI_APP_PICKER_POLL_INTERVAL_MS,
      signal
    );
    if (!waited || isAborted(signal)) {
      return "aborted";
    }
    try {
      const result: Readonly<MiniAppPickerResultEvent> | null =
        await pollMiniAppPickerResult(requestId, signal);
      if (isAborted(signal)) {
        return "aborted";
      }
      if (result !== null) {
        return result;
      }
    } catch (error: unknown) {
      if (isAborted(signal)) {
        return "aborted";
      }
      const message: string = errorMessage(error);
      if (
        classifyMiniAppAuthError(message, error) !== null ||
        attempt === MINI_APP_PICKER_POLL_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }
  return "timeout";
}
