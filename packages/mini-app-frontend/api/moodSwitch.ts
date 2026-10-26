import type { MiniAppMoodMutationResult } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/mood/switch` 触发重抽 AI 全局情绪并返回新抽出的情绪名。
 * @returns 情绪切换响应结果
 */
export async function switchMiniAppMood(): Promise<MiniAppMoodMutationResult> {
  return miniAppFetchJson<MiniAppMoodMutationResult>("./api/mood/switch", {
    method: "POST",
  });
}
