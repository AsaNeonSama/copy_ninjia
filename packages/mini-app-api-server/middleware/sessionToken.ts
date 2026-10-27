import { miniAppAuthSessions } from "../../cache/main/miniApp";
import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import type {
  MiniAppAuthSession,
  MiniAppMiddleware,
  MiniAppRouteContext,
} from "../../types/miniApp";
import { purgeExpiredAuthSessions } from "../auth/session";
import { extractSessionToken } from "../libs/request";
import { accessErrorResponse } from "../libs/response";

/**
 * 校验请求携带的 45 分钟有效期访问密码认证会话令牌（先清理已过期会话）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `session`。
 * @returns 验证通过时返回 `null`，缺失或过期时返回 `401 PASSWORD_REQUIRED` JSON `Response`。
 */
function verifySessionTokenRequest(request: Request, allowQueryAuth: boolean): Response | null {
  const nowMs: number = Date.now();
  purgeExpiredAuthSessions(nowMs);
  const sessionToken: string = extractSessionToken(request, allowQueryAuth);
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "PASSWORD_REQUIRED",
    });
  }
  const session: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(sessionToken);
  if (session === undefined || session.expiresAt <= nowMs) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "SESSION_EXPIRED",
    });
  }
  return null;
}

/**
 * 创建校验 45 分钟密码认证会话令牌（`X-Mini-App-Session`）的中间件（第二层会话校验）。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `session` 查询参数提取凭据（供附件下载）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppSessionMiddleware(allowQueryAuth: boolean): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> =>
    verifySessionTokenRequest(ctx.request, allowQueryAuth) ?? next();
}
