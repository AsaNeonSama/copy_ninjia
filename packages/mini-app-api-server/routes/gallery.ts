import type { MiniAppRouteContext } from "../../types/miniApp";
import {
  handleDeleteGalleryFileByName,
  handleDownloadGalleryFileByName,
  handleGetGalleryFileByName,
  handleGetGalleryRoute,
  handlePostGalleryDeleteRoute,
  handlePostGalleryUploadRoute,
} from "../handlers/gallery";
import {
  MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
  MINI_APP_GALLERY_DOWNLOAD_MIDDLEWARE_CHAIN,
  MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
} from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/**
 * 构建图库路由的 `Bun.serve` 原生路由表片段：列表、上传与删除走完整双层鉴权链，单张预览读取走受保护资源链，
 * 附件下载走允许查询参数凭据的下载链。
 * @returns 图库路由表片段。
 */
export function createGalleryBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const downloadHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    MINI_APP_GALLERY_DOWNLOAD_MIDDLEWARE_CHAIN,
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleDownloadGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );
  const fileHandler: (request: Request) => Promise<Response> = withMiniAppMiddlewareChain(
    MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleGetGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );
  return {
    "/api/gallery": {
      GET: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetGalleryRoute(ctx.url)
      ),
    },
    "/api/gallery/upload": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostGalleryUploadRoute(ctx.request)
      ),
    },
    "/api/gallery/delete": {
      POST: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostGalleryDeleteRoute(ctx.request)
      ),
    },
    "/api/gallery/download/:fileName": { GET: downloadHandler, HEAD: downloadHandler },
    "/api/gallery/file/:fileName": {
      GET: fileHandler,
      HEAD: fileHandler,
      DELETE: withMiniAppMiddlewareChain(
        MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleDeleteGalleryFileByName(ctx.params.fileName ?? "")
      ),
    },
  };
}
