import type { MiniAppBatchKickResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/chats/:chatId/batch-kick` 按 1–24 小时回溯窗口触发指定群的 `/batch_kick` 批量清理。
 * @param chatId 目标群 ID
 * @param hours 回溯小时数（`1..24`）
 * @returns 批量清理触发结果
 */
export async function triggerMiniAppChatBatchKick(
  chatId: number,
  hours: number
): Promise<MiniAppBatchKickResult> {
  return miniAppFetchJson(`./api/chats/${encodeURIComponent(String(chatId))}/batch-kick`, {
    method: "POST",
    body: JSON.stringify({ hours }),
  });
}
