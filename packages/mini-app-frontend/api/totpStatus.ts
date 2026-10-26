import type { MiniAppTotpStatusView } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `GET ./api/totp` 查询当前 Google Authenticator 验证器的启用状态与脱敏摘要。
 * @returns 验证器状态视图
 */
export async function fetchMiniAppTotpStatus(): Promise<MiniAppTotpStatusView> {
  return miniAppFetchJson<MiniAppTotpStatusView>("./api/totp");
}
