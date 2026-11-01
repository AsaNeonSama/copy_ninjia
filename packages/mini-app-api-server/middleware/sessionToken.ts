import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import type {
  MiniAppAuthSession,
  MiniAppMiddleware,
  MiniAppRouteContext,
} from "../../types/miniApp";
import {
  attachRefreshedSessionHeaders,
  resolveAndRefreshMiniAppAuthSession,
} from "../auth/session";
import { extractSessionToken } from "../libs/request";
import { accessErrorResponse } from "../libs/response";

/**
 * 创建校验 45 分钟密码认证会话令牌（`X-Mini-App-Session`）的中间件（第二层会话校验）。
 * 当有效会话距签发时刻超过 5 分钟时自动签发新令牌、顺延有效期并通过响应头下发给客户端。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `session` 查询参数提取凭据（供附件下载）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppSessionMiddleware(allowQueryAuth: boolean): MiniAppMiddleware {
  return async (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Promise<Response> => {
    const nowMs: number = Date.now();
    const sessionToken: string = extractSessionToken(ctx.request, allowQueryAuth);
    if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
      return accessErrorResponse(ctx.request, {
        status: 401,
        code: "PASSWORD_REQUIRED",
        reason: "password_required",
        error: "PASSWORD_REQUIRED",
      });
    }
    const session: Readonly<MiniAppAuthSession> | null =
      resolveAndRefreshMiniAppAuthSession(sessionToken, nowMs);
    if (session === null) {
      return accessErrorResponse(ctx.request, {
        status: 401,
        code: "PASSWORD_REQUIRED",
        reason: "password_required",
        error: "SESSION_EXPIRED",
      });
    }
    const response: Response = await next();
    if (session.token === sessionToken) {
      return response;
    }
    return attachRefreshedSessionHeaders(response, session);
  };
}
