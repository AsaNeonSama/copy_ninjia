import { setMiniAppAssetToken, setMiniAppSessionToken } from "../libs/credentials";
import type { MiniAppLoginSuccessResponse } from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/auth/login` 提交 6 位 TOTP 动态码（优先）或访问密码并获取 45 分钟有效期的认证会话令牌。
 * @param credential 用户输入的 6 位 TOTP 验证码或访问密码
 * @param mode 当前登录校验模式（`"totp"` 或 `"password"`）
 * @returns 登录成功响应（含 `sessionToken` 与 `expiresAt`）
 */
export async function loginMiniAppWithPassword(
  credential: string, mode: MiniAppAuthMode = "password"
): Promise<MiniAppLoginSuccessResponse> {
  const response: MiniAppLoginSuccessResponse =
    await miniAppFetchJson<MiniAppLoginSuccessResponse>("./api/auth/login", {
      method: "POST",
      body: JSON.stringify(
        mode === "totp" ? { totpCode: credential, password: credential } : { password: credential }
      ),
    });
  if (typeof response.assetToken === "string" && response.assetToken.length > 0) {
    setMiniAppAssetToken(response.assetToken);
  }
  setMiniAppSessionToken(response.sessionToken, response.expiresAt);
  return response;
}
