import type { MiniAppRouteContext } from "../../types/miniApp";
import { accessErrorResponse } from "../libs/response";

/**
 * 拦截跨站请求（`Sec-Fetch-Site: cross-site`）的通用安全边界中间件，位于每条鉴权中间件链的首位。
 * @param ctx 路由请求上下文。
 * @param next 调用下一环中间件的回调。
 * @returns 跨站时返回 `403 CROSS_SITE_FORBIDDEN`，否则返回后续中间件链的响应。
 */
export function miniAppCrossSiteGuardMiddleware(
  ctx: Readonly<MiniAppRouteContext>,
  next: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (ctx.request.headers.get("sec-fetch-site") === "cross-site") {
    return accessErrorResponse(ctx.request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "CROSS_SITE_FORBIDDEN",
    });
  }
  return next();
}
