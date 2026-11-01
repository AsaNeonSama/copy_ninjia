import { setMiniAppAssetToken, setMiniAppSessionToken } from "../libs/credentials";
import type { MiniAppLoginSuccessResponse } from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import { miniAppFetchJson } from "./request";

/**
 * 调用 `POST ./api/auth/login` 提交 6 位 TOTP 动态码（优先）或访问密码，保存签发的 45 分钟认证会话令牌与资源令牌；
 * 会话的本机到期时刻取收到响应时的本机时刻加服务端 `ttlMs`，经 `readMiniAppSessionExpiresAt` 读取。
 * @param credential 用户输入的 6 位 TOTP 验证码或访问密码
 * @param mode 当前登录校验模式（`"totp"` 或 `"password"`）
 */
export async function loginMiniAppWithPassword(
  credential: string, mode: MiniAppAuthMode = "password"
): Promise<void> {
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
  setMiniAppSessionToken(response.sessionToken, Date.now() + response.ttlMs);
}
