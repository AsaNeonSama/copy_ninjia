import { MINI_APP_SESSION_HEADER } from "../consts/miniApp";
import { buildMiniAppAuthHeaders } from "./request";

/**
 * 调用 `POST ./api/auth/logout` 通知服务端吊销给定的 45 分钟会话令牌（请求头携带 `initData` 与该令牌，
 * 以 `keepalive` 发送以便页面随即关闭时仍能送达）。不读取响应、不同步刷新令牌；网络或服务端失败时静默结束，
 * 本地凭据由调用方另行清除。
 * @param sessionToken 待吊销的 64 位十六进制会话令牌
 */
export async function logoutMiniAppSession(sessionToken: string): Promise<void> {
  const headers: Record<string, string> = buildMiniAppAuthHeaders(false);
  headers[MINI_APP_SESSION_HEADER] = sessionToken;
  try {
    await fetch("./api/auth/logout", { method: "POST", headers, keepalive: true });
  } catch (_error: unknown) {
    // 吊销失败不影响本地锁定；服务端会话按 45 分钟有效期自然过期。
  }
}
