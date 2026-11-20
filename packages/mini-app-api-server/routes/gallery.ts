import type {
  MiniAppBunRouteHandler,
  MiniAppBunRouteTable,
  MiniAppRouteContext,
  MiniAppRouteHandler,
} from "../../types/miniApp/server";
import {
  handleDownloadGalleryFileRoute,
  handleGetGalleryFileRoute,
  handleGetGalleryRoute,
  handlePostGalleryDeleteRoute,
  handlePostGalleryDownloadTicketRoute,
  handlePostGalleryUploadRoute,
  handleTicketDownloadGalleryFileRoute,
} from "../handlers/gallery";
import {
  MINI_APP_API_AUTH_POLICY,
  MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY,
} from "../../consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_PARAM,
  MINI_APP_GALLERY_FILE_AUTH_POLICY,
  MINI_APP_GALLERY_UPLOAD_AUTH_POLICY,
} from "../../consts/miniAppCrypto";
import { runMiniAppAuthorized, withMiniAppAuth } from "../middleware/pipeline";

/** 已完成双层请求头鉴权与 `?e=` 解封后的回退附件下载终态处理器。 */
const GALLERY_DOWNLOAD_ENCRYPTED_HANDLER: MiniAppRouteHandler = (
  ctx: Readonly<MiniAppRouteContext>
): Promise<Response> => handleDownloadGalleryFileRoute(ctx.request, ctx.url);

/** 附件下载路由处理器：携带 `?ticket=` 时走 60 秒单次票据通道（供原生 `WebApp.downloadFile`），否则走请求头双层鉴权 + `?e=` 通道（供前端 `blob:` 回退下载）。 */
const GALLERY_DOWNLOAD_HANDLER: MiniAppBunRouteHandler = (
  request: Request
): Promise<Response> => {
  const url: URL = new URL(request.url);
  const ctx: Readonly<MiniAppRouteContext> = {
    request,
    url,
    method: request.method.toUpperCase(),
  };
  if (url.searchParams.has(MINI_APP_DOWNLOAD_TICKET_PARAM)) {
    return handleTicketDownloadGalleryFileRoute(ctx);
  }
  return runMiniAppAuthorized(
    ctx,
    MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY,
    GALLERY_DOWNLOAD_ENCRYPTED_HANDLER
  );
};

/** 图库单张预览读取路由处理器（经双层会话鉴权与 `?e=` 加密查询串策略）。 */
const GALLERY_FILE_HANDLER: MiniAppBunRouteHandler = withMiniAppAuth(
  MINI_APP_GALLERY_FILE_AUTH_POLICY,
  (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
    handleGetGalleryFileRoute(ctx.request, ctx.url)
);

/**
 * 图库路由的 `Bun.serve` 原生路由表片段：列表、上传、删除与一次性下载票据签发走完整双层鉴权策略，
 * 单张预览读取走双层会话与 `?e=` 加密查询策略，附件下载支持 `?ticket=` 一次性票据或请求头 `?e=` 加密下载。
 */
export const MINI_APP_GALLERY_BUN_ROUTES: MiniAppBunRouteTable = {
  "/api/gallery": {
    GET: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handleGetGalleryRoute(ctx.url)
    ),
  },
  "/api/gallery/upload": {
    POST: withMiniAppAuth(
      MINI_APP_GALLERY_UPLOAD_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostGalleryUploadRoute(ctx.request)
    ),
  },
  "/api/gallery/delete": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostGalleryDeleteRoute(ctx.request)
    ),
  },
  "/api/gallery/download-ticket": {
    POST: withMiniAppAuth(
      MINI_APP_API_AUTH_POLICY,
      (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostGalleryDownloadTicketRoute(ctx.request, ctx.sessionLineageId)
    ),
  },
  "/api/gallery/download": {
    GET: GALLERY_DOWNLOAD_HANDLER,
    HEAD: GALLERY_DOWNLOAD_HANDLER,
  },
  "/api/gallery/file": {
    GET: GALLERY_FILE_HANDLER,
    HEAD: GALLERY_FILE_HANDLER,
  },
};
