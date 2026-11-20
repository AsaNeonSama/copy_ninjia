import type { MiniAppChatDetail } from "../types/miniApp/chats";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/chats/detail`（通过加密查询参数 `chatId`）拉取指定群的详细状态与功能开关快照。
 * @param chatId 目标群 ID
 * @returns 群详细状态视图
 */
export async function fetchMiniAppChatDetail(chatId: number): Promise<MiniAppChatDetail> {
  const response: { readonly detail: MiniAppChatDetail } = await miniAppFetchJson(
    `./api/chats/detail?chatId=${encodeURIComponent(String(chatId))}`
  );
  return response.detail;
}
