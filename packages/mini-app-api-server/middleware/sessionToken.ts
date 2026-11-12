import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import {
  attachRefreshedSessionHeaders,
  resolveAndRefreshCheckedMiniAppAuthSession,
} from "../auth/session";
import {
  extractAssetTokenFromQuery,
  extractSessionToken,
} from "../libs/request";
import { accessErrorResponse } from "../libs/response";

/**
 * 创建校验 45 分钟密码认证会话令牌（`X-Mini-App-Session`）的中间件（第二层会话校验）。
 * 当有效会话距签发时刻超过 5 分钟时自动签发新令牌、顺延有效期并通过响应头下发给客户端。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `session` 查询参数提取凭据（供图库预览与附件下载）。
 * @param allowVerifiedAssetTokenBypass 在前置 `initData` 中间件已验明 `?token=` 受保护资源令牌且请求未显式携带会话令牌时，是否直接放行以支持 7 天静态缓存（用于受保护图片资源链）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppSessionMiddleware(
  allowQueryAuth: boolean,
  allowVerifiedAssetTokenBypass: boolean = false
): MiniAppMiddleware {
  return async (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Promise<Response> => {
    const sessionToken: string = extractSessionToken(
      ctx.request,
      allowQueryAuth ? ctx.url : null
    );
    if (
      allowVerifiedAssetTokenBypass &&
      sessionToken.length === 0 &&
      extractAssetTokenFromQuery(ctx.request, ctx.url).length > 0
    ) {
      return next();
    }
    const nowMs: number = Date.now();
    if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
      return accessErrorResponse(ctx.request, {
        status: 401,
        code: "PASSWORD_REQUIRED",
        reason: "password_required",
        error: "PASSWORD_REQUIRED",
      });
    }
    const session: Readonly<MiniAppAuthSession> | null =
      resolveAndRefreshCheckedMiniAppAuthSession(sessionToken, nowMs);
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
