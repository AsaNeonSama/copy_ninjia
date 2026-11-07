import type {
  MiniAppBunRouteHandler,
  MiniAppBunRouteTable,
  MiniAppRouteContext,
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
  MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
  MINI_APP_GALLERY_DOWNLOAD_MIDDLEWARE_CHAIN,
  MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
} from "../middleware/chains";
import { withMiniAppMiddlewareChain } from "../middleware/pipeline";

/** 附件下载路由处理器（允许查询参数凭据）。 */
const GALLERY_DOWNLOAD_HANDLER: MiniAppBunRouteHandler =
  withMiniAppMiddlewareChain(
    MINI_APP_GALLERY_DOWNLOAD_MIDDLEWARE_CHAIN,
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleDownloadGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );

/** 图库单张预览读取路由处理器（经受保护资源鉴权链）。 */
const GALLERY_FILE_HANDLER: MiniAppBunRouteHandler =
  withMiniAppMiddlewareChain(
    MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN,
    (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
      handleGetGalleryFileByName(ctx.request, ctx.params.fileName ?? "")
  );

/**
 * 图库路由的 `Bun.serve` 原生路由表片段：列表、上传与删除走完整双层鉴权链，单张预览读取走受保护资源链，
 * 附件下载走允许查询参数凭据的下载链。
 */
export const MINI_APP_GALLERY_BUN_ROUTES: MiniAppBunRouteTable = {
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
  "/api/gallery/download/:fileName": {
    GET: GALLERY_DOWNLOAD_HANDLER,
    HEAD: GALLERY_DOWNLOAD_HANDLER,
  },
  "/api/gallery/file/:fileName": {
    GET: GALLERY_FILE_HANDLER,
    HEAD: GALLERY_FILE_HANDLER,
    DELETE: withMiniAppMiddlewareChain(
      MINI_APP_API_AUTH_MIDDLEWARE_CHAIN,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleDeleteGalleryFileByName(ctx.params.fileName ?? "")
    ),
  },
};
