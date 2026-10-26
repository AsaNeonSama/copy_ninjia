import { MINI_APP_SVG_RESOURCE_ROUTE_PATTERN } from "../../consts/miniApp";
import type { MiniAppRouteContext, MiniAppRouteMatch } from "../../types/miniApp";
import { handleGetSvgResourceByName } from "../handlers/resource";
import { getMiniAppProtectedAssetMiddlewareChain, withMiniAppMiddlewareChain } from "../middleware";

/**
 * 构建受保护 SVG 图标资源路由（`GET|HEAD /api/resources/svg/:fileName` 与 `GET|HEAD /miniAppResoures/:fileName`）的
 * `Bun.serve` 原生路由表片段，经受保护资源中间件链。
 * @returns SVG 资源路由表片段。
 */
export function createResourceBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const svgHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    getMiniAppProtectedAssetMiddlewareChain(),
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleGetSvgResourceByName(ctx.request, ctx.params.fileName ?? "")
  );
  return {
    "/api/resources/svg/:fileName": { GET: svgHandler, HEAD: svgHandler },
    "/miniAppResoures/:fileName": { GET: svgHandler, HEAD: svgHandler },
  };
}

/**
 * 在兜底分发的受保护资源中间件链内匹配 SVG 图标资源读取路由（`GET|HEAD /api/resources/svg/:fileName` 与 `GET|HEAD /miniAppResoures/:fileName`）。
 * @param ctx 已通过受保护资源中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchSvgResourceRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method !== "GET" && ctx.method !== "HEAD") return null;
  const svgMatch: RegExpExecArray | null =
    MINI_APP_SVG_RESOURCE_ROUTE_PATTERN.exec(ctx.routePath);
  if (svgMatch === null) return null;
  return handleGetSvgResourceByName(ctx.request, svgMatch[1] ?? "");
}
