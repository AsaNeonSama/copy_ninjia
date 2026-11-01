import {
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
} from "../consts/miniApp";
import { errorMessage } from "../libs/errorMessage";
import type { MiniAppPickerResultEvent } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/picker/result` 查询原生选择器会话的共享结果回执。
 * @param requestId 预备选择器请求 ID
 * @returns 已完成回执；尚未收到时返回 `null`
 */
export async function pollMiniAppPickerResult(
  requestId: number
): Promise<Readonly<MiniAppPickerResultEvent> | null> {
  const response: { readonly result: Readonly<MiniAppPickerResultEvent> | null } =
    await miniAppFetchJson(`./api/picker/result?requestId=${encodeURIComponent(String(requestId))}`);
  return response.result;
}

/**
 * 按固定间隔轮询原生选择器会话回执，直至收到结果或达到最大尝试次数。
 * 单次查询失败（网络抖动、服务端 5xx 等）不中断轮询；会话缺失或锁定（`[PASSWORD_REQUIRED]` / `[PASSWORD_LOCKED]`）立即抛出，
 * 由调用方经根 store 的 `notify` 锁定控制台；最后一轮查询失败时抛出该轮错误。
 * @param requestId 预备选择器请求 ID
 * @returns 命中回执时返回事件对象，最后一轮查询成功但仍无回执时返回 `"timeout"`
 */
export async function waitForMiniAppPickerResult(
  requestId: number
): Promise<Readonly<MiniAppPickerResultEvent> | "timeout"> {
  for (
    let attempt: number = 0;
    attempt < MINI_APP_PICKER_POLL_MAX_ATTEMPTS;
    attempt += 1
  ) {
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, MINI_APP_PICKER_POLL_INTERVAL_MS);
    });
    try {
      const result: Readonly<MiniAppPickerResultEvent> | null =
        await pollMiniAppPickerResult(requestId);
      if (result !== null) {
        return result;
      }
    } catch (error: unknown) {
      const message: string = errorMessage(error);
      if (
        message.includes("[PASSWORD_REQUIRED]") ||
        message.includes("[PASSWORD_LOCKED]") ||
        attempt === MINI_APP_PICKER_POLL_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }
  return "timeout";
}
