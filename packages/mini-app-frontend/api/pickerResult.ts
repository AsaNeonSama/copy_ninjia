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
