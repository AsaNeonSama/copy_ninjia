import type { MiniAppChatSummary } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/chats` 拉取所有已启用 `/init` 的受管群列表。
 * @returns 已初始化群摘要列表
 */
export async function fetchMiniAppChats(): Promise<readonly Readonly<MiniAppChatSummary>[]> {
  const response: { readonly items: readonly Readonly<MiniAppChatSummary>[] } =
    await miniAppFetchJson("./api/chats");
  return response.items;
}
