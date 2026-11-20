import type { MiniAppMessagePage } from "../types/miniApp/chats";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/chats/messages`（通过加密查询参数 `chatId`、`page`、`pageSize`）分页拉取指定群的热 256 条发言记录（不含压缩记忆摘要）。
 * @param chatId 目标群 ID
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @returns 热发言记录分页结果
 */
export async function fetchMiniAppChatMessages(
  chatId: number, page: number, pageSize: number
): Promise<MiniAppMessagePage> {
  return miniAppFetchJson(
    `./api/chats/messages?chatId=${encodeURIComponent(String(chatId))}&page=${encodeURIComponent(String(page))}&pageSize=${encodeURIComponent(String(pageSize))}`
  );
}
