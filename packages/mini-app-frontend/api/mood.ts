import type { MiniAppMoodView } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/mood` 查询当前全局生效的 AI 情绪。
 * @returns AI 情绪状态视图
 */
export async function fetchMiniAppMood(): Promise<MiniAppMoodView> {
  return miniAppFetchJson<MiniAppMoodView>("./api/mood");
}
