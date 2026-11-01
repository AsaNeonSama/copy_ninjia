import type { MiniAppStatusView } from "../types/miniApp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/status` 拉取首页实时运行状态快照。
 * @returns 实时状态视图
 */
export async function fetchMiniAppStatus(): Promise<MiniAppStatusView> {
  return miniAppFetchJson<MiniAppStatusView>("./api/status");
}
