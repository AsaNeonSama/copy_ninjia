import type { MiniAppTotpMutationResponse } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `DELETE ./api/totp` 删除当前唯一的 Google Authenticator 验证器并恢复密码登录。
 * @returns 删除结果
 */
export async function deleteMiniAppTotp(): Promise<MiniAppTotpMutationResponse> {
  return miniAppFetchJson<MiniAppTotpMutationResponse>("./api/totp", { method: "DELETE" });
}
