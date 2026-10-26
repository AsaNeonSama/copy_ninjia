import type { MiniAppRouteContext } from "../../types/miniApp";
import { accessErrorResponse } from "../libs/response";

/**
 * 拦截从浏览器地址栏直接导航访问受保护图片或 SVG 资源（`Sec-Fetch-Dest: document` 或 `Sec-Fetch-Mode: navigate`）的边界中间件。
 * @param ctx 路由请求上下文。
 * @param next 调用下一环中间件的回调。
 * @returns 直接导航时返回 `403 DIRECT_NAVIGATION_FORBIDDEN`，否则返回后续中间件链的响应。
 */
export function miniAppAssetNavigationGuardMiddleware(
  ctx: Readonly<MiniAppRouteContext>,
  next: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (
    ctx.request.headers.get("sec-fetch-dest") === "document" ||
    ctx.request.headers.get("sec-fetch-mode") === "navigate"
  ) {
    return accessErrorResponse(ctx.request, {
      status: 403,
      code: "DIRECT_NAVIGATION_FORBIDDEN",
      reason: "forbidden_user",
      error: "DIRECT_NAVIGATION_FORBIDDEN",
    });
  }
  return next();
}
