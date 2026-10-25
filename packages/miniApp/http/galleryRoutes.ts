import {
  MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN,
  MINI_APP_GALLERY_FILE_ROUTE_PATTERN,
  MINI_APP_SVG_RESOURCE_ROUTE_PATTERN,
} from "../../consts/miniApp";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryUploadResult,
  ResolvedMiniAppGalleryFile,
  ResolvedMiniAppSvgResource,
} from "../../types/miniApp";
import {
  deleteMiniAppGalleryImage,
  listMiniAppGalleryPage,
  readMiniAppGalleryFile,
  readMiniAppSvgResource,
  uploadMiniAppGalleryImage,
} from "../galleryView";
import { buildMiniAppGalleryDownloadFileName } from "../ui/formatters";
import {
  buildAssetCacheHeaders,
  buildNoStoreHeaders,
  jsonResponse,
  parseOptionalSafeInt,
  readJsonObjectBody,
} from "./common";

/**
 * 构造带浏览器与 CDN 缓存头及 `ETag` 强校验（命中 `If-None-Match` 返回 `304 Not Modified`）的受保护资源响应。
 * @param request HTTP 请求对象。
 * @param body 响应体（`Bun.BunFile`）。
 * @param meta 已解析资源的 MIME、字节长度与 `ETag`。
 * @returns `200 OK` 或 `304 Not Modified` 的 `Response` 实例。
 */
function serveCachedAssetResponse(
  request: Request,
  body: Bun.BunFile,
  meta: Readonly<{
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly etag: string;
  }>
): Response {
  const headers: Record<string, string> = buildAssetCacheHeaders(
    meta.mimeType,
    meta.sizeBytes,
    meta.etag
  );
  if (request.headers.get("if-none-match") === meta.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method.toUpperCase() === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

/**
 * 处理 `GET /api/gallery`：分页返回当前配置图库目录中的图片元数据列表。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handleGetGalleryRoute(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("pageSize")
  );
  return jsonResponse(await listMiniAppGalleryPage(page, pageSize));
}

/**
 * 处理 `GET /api/gallery/file/:fileName`（及 `HEAD`）：在前置受保护资源中间件链完成 Telegram WebApp 签名或资源令牌、超管 ID 与防直接导航核验后，经文件名安全校验返回允许浏览器与 CDN 缓存的图片二进制流（或命中 `If-None-Match` 时返回 `304 Not Modified`）。
 * @param request HTTP 请求。
 * @param rawFileName URL 中的文件名参数。
 * @returns 图片文件响应、`304` 缓存命中响应或 `404` JSON 响应。
 */
export async function handleGetGalleryFileByName(
  request: Request,
  rawFileName: string
): Promise<Response> {
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  return serveCachedAssetResponse(request, Bun.file(resolved.filePath), resolved);
}

/**
 * 处理 `GET|HEAD /api/gallery/download/:fileName`：在前置下载中间件链完成完整双层鉴权（跨站拦截 + 超管 `initData` 签名或资源令牌 + 90 分钟 `session` 会话令牌）后，经文件名安全校验返回带秒级时间戳文件名 `Content-Disposition: attachment` 下载头与 `no-store` 防缓存策略的图片原始二进制流。
 * @param request HTTP 请求对象。
 * @param rawFileName URL 中的文件名参数。
 * @returns 附件下载图片文件响应或 `404` JSON 响应。
 */
export async function handleDownloadGalleryFileByName(
  request: Request,
  rawFileName: string
): Promise<Response> {
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  const downloadFileName: string = buildMiniAppGalleryDownloadFileName(
    resolved.fileName
  );
  const headers: Record<string, string> = buildNoStoreHeaders(resolved.mimeType);
  headers["Content-Length"] = String(resolved.sizeBytes);
  headers["Content-Disposition"] = `attachment; filename="${downloadFileName}"`;
  return new Response(
    request.method.toUpperCase() === "HEAD" ? null : Bun.file(resolved.filePath),
    {
      status: 200,
      headers,
    }
  );
}

/**
 * 处理 `GET /api/resources/svg/:fileName` 与 `GET /miniAppResoures/:fileName`（及 `HEAD`）：在前置受保护资源中间件链完成 Telegram WebApp 签名或资源令牌、超管 ID 与防直接导航核验后，返回允许浏览器与 CDN 缓存的 SVG 图标流（或命中 `If-None-Match` 时返回 `304 Not Modified`）。
 * @param request HTTP 请求。
 * @param rawFileName URL 中的 SVG 文件名参数。
 * @returns SVG 响应、`304` 缓存命中响应或 `404` JSON 响应。
 */
export async function handleGetSvgResourceByName(
  request: Request,
  rawFileName: string
): Promise<Response> {
  const resolved: Readonly<ResolvedMiniAppSvgResource> | null =
    await readMiniAppSvgResource(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "SVG resource not found" }, 404);
  }
  return serveCachedAssetResponse(request, resolved.file, resolved);
}

/**
 * 处理 `POST /api/gallery/upload`：按现有 `/h_image add` 的字节上限、魔数格式、像素尺寸与 SHA-256 协议将上传的图片写入图库目录。
 * @param request HTTP 请求（请求体为图片原始字节）。
 * @returns 上传入库结果 JSON 响应。
 */
export async function handlePostGalleryUploadRoute(
  request: Request
): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await request.bytes();
  } catch (_error: unknown) {
    return jsonResponse(
      {
        ok: false,
        outcome: "failed",
        message: "无法读取上传的图片请求体。",
      },
      400
    );
  }
  const result: Readonly<MiniAppGalleryUploadResult> =
    await uploadMiniAppGalleryImage(bytes);
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `DELETE /api/gallery/file/:fileName`：在前置中间件链完成双层鉴权后从图库目录删除指定图片文件。
 * @param rawFileName URL 中的文件名参数。
 * @returns 删除结果 JSON 响应。
 */
export async function handleDeleteGalleryFileByName(
  rawFileName: string
): Promise<Response> {
  const result: Readonly<MiniAppGalleryDeleteResult> =
    await deleteMiniAppGalleryImage(rawFileName);
  const status: number = result.ok
    ? 200
    : result.outcome === "notFound"
      ? 404
      : 400;
  return jsonResponse(result, status);
}

/**
 * 处理 `POST /api/gallery/delete`：按请求体 `fileName` 从图库目录删除指定图片文件。
 * @param request HTTP 请求。
 * @returns 删除结果 JSON 响应。
 */
export async function handlePostGalleryDeleteRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const fileName: string =
    typeof body?.fileName === "string" ? body.fileName.trim() : "";
  return handleDeleteGalleryFileByName(fileName);
}

/**
 * 匹配并处理受保护图片与 SVG 静态/动态资源读取路由（`GET|HEAD /api/gallery/file/:fileName`、`GET|HEAD /api/resources/svg/:fileName`、`GET|HEAD /miniAppResoures/:fileName`）。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @param request HTTP 请求对象。
 * @returns 命中时返回 `Response`，未命中时返回 `null`。
 */
export async function handleProtectedAssetRoute(
  method: string,
  routePath: string,
  request: Request
): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  const galleryMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.exec(routePath);
  if (galleryMatch !== null) {
    return handleGetGalleryFileByName(request, galleryMatch[1] ?? "");
  }
  const svgMatch: RegExpExecArray | null =
    MINI_APP_SVG_RESOURCE_ROUTE_PATTERN.exec(routePath);
  if (svgMatch !== null) {
    return handleGetSvgResourceByName(request, svgMatch[1] ?? "");
  }
  return null;
}

/**
 * 兜底匹配并处理 `/api/gallery` 列表、上传、下载与删除路由（不含单张图片内联预览读取流）。
 * @param method 大写 HTTP 方法。
 * @param routePath 归一化后的内部路由路径。
 * @param request HTTP 请求对象。
 * @returns 命中时返回 `Response`，未命中时返回 `null`。
 */
export async function handleGalleryApiRoute(
  method: string,
  routePath: string,
  request: Request
): Promise<Response | null> {
  if (method === "GET" && routePath === "/api/gallery") {
    return handleGetGalleryRoute(request);
  }
  if (method === "POST" && routePath === "/api/gallery/upload") {
    return handlePostGalleryUploadRoute(request);
  }
  if (method === "POST" && routePath === "/api/gallery/delete") {
    return handlePostGalleryDeleteRoute(request);
  }
  const downloadMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN.exec(routePath);
  if (downloadMatch !== null && (method === "GET" || method === "HEAD")) {
    return handleDownloadGalleryFileByName(request, downloadMatch[1] ?? "");
  }
  const fileMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.exec(routePath);
  if (fileMatch !== null && method === "DELETE") {
    return handleDeleteGalleryFileByName(fileMatch[1] ?? "");
  }
  return null;
}
