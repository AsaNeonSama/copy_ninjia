import {
  MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN,
  MINI_APP_GALLERY_FILE_ROUTE_PATTERN,
} from "../../consts/miniApp";
import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteMatch,
} from "../../types/miniApp";
import {
  handleDeleteGalleryFileByName,
  handleDownloadGalleryFileByName,
  handleGetGalleryFileByName,
  handleGetGalleryRoute,
  handlePostGalleryDeleteRoute,
  handlePostGalleryUploadRoute,
} from "../handlers/gallery";
import {
  executeMiniAppMiddlewareChain,
  getMiniAppApiAuthMiddlewareChain,
  getMiniAppGalleryDownloadMiddlewareChain,
  getMiniAppProtectedAssetMiddlewareChain,
  withMiniAppMiddlewareChain,
} from "../middleware";

/**
 * 构建图库路由的 `Bun.serve` 原生路由表片段：列表、上传与删除走完整双层鉴权链，单张预览读取走受保护资源链，
 * 附件下载走允许查询参数凭据的下载链。
 * @returns 图库路由表片段。
 */
export function createGalleryBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const apiAuthChain: readonly MiniAppMiddleware[] = getMiniAppApiAuthMiddlewareChain();
  const downloadHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    getMiniAppGalleryDownloadMiddlewareChain(),
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleDownloadGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );
  const fileHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    getMiniAppProtectedAssetMiddlewareChain(),
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleGetGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );
  return {
    "/api/gallery": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handleGetGalleryRoute(ctx.url)
      ),
    },
    "/api/gallery/upload": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostGalleryUploadRoute(ctx.request)
      ),
    },
    "/api/gallery/delete": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> => handlePostGalleryDeleteRoute(ctx.request)
      ),
    },
    "/api/gallery/download/:fileName": { GET: downloadHandler, HEAD: downloadHandler },
    "/api/gallery/file/:fileName": {
      GET: fileHandler,
      HEAD: fileHandler,
      DELETE: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleDeleteGalleryFileByName(ctx.params.fileName ?? "")
      ),
    },
  };
}

/**
 * 在兜底分发中匹配图库原图附件下载路由（`GET|HEAD /api/gallery/download/:fileName`），经下载中间件链执行。
 * @param ctx 路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchGalleryDownloadRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method !== "GET" && ctx.method !== "HEAD") return null;
  const downloadMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN.exec(ctx.routePath);
  if (downloadMatch === null) return null;
  return executeMiniAppMiddlewareChain(
    ctx,
    getMiniAppGalleryDownloadMiddlewareChain(),
    (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleDownloadGalleryFileByName(routeCtx.request, downloadMatch[1] ?? "")
  );
}

/**
 * 在兜底分发的受保护资源中间件链内匹配图库单张图片预览读取路由（`GET|HEAD /api/gallery/file/:fileName`）。
 * @param ctx 已通过受保护资源中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchGalleryFileRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  if (ctx.method !== "GET" && ctx.method !== "HEAD") return null;
  const galleryMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.exec(ctx.routePath);
  if (galleryMatch === null) return null;
  return handleGetGalleryFileByName(ctx.request, galleryMatch[1] ?? "");
}

/**
 * 在兜底分发的业务 API 中间件链内匹配图库列表、上传与删除路由（附件下载与单张预览读取已在进入该链前分流）。
 * @param ctx 已通过业务 API 中间件链的路由请求上下文。
 * @returns 命中时返回响应，未命中时返回 `null`。
 */
export function dispatchGalleryApiRoute(ctx: Readonly<MiniAppRouteContext>): MiniAppRouteMatch {
  const { method, routePath, request }: Readonly<MiniAppRouteContext> = ctx;
  if (method === "GET" && routePath === "/api/gallery") {
    return handleGetGalleryRoute(ctx.url);
  }
  if (method === "POST" && routePath === "/api/gallery/upload") {
    return handlePostGalleryUploadRoute(request);
  }
  if (method === "POST" && routePath === "/api/gallery/delete") {
    return handlePostGalleryDeleteRoute(request);
  }
  const fileMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.exec(routePath);
  if (fileMatch !== null && method === "DELETE") {
    return handleDeleteGalleryFileByName(fileMatch[1] ?? "");
  }
  return null;
}
