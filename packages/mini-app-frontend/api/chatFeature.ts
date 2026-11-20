import type { MiniAppFeatureKey, MiniAppFeatureToggleResult } from "../types/miniApp/chats";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/chats/feature` 切换指定群的单项功能开关（含 `/init`）。
 * @param chatId 目标群 ID
 * @param feature 功能键
 * @param enabled 目标布尔状态
 * @returns 开关变更结果
 */
export async function toggleMiniAppChatFeature(
  chatId: number, feature: MiniAppFeatureKey, enabled: boolean
): Promise<MiniAppFeatureToggleResult> {
  return miniAppFetchJson("./api/chats/feature", {
    method: "POST", body: JSON.stringify({ chatId, feature, enabled }),
  });
}
