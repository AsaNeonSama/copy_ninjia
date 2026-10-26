import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryUploadResult,
  ResolvedMiniAppGalleryFile,
} from "../../types/miniApp";
import { buildMiniAppGalleryDownloadFileName } from "../libs/downloadFileName";
import { parseOptionalSafeInt, readJsonObjectBody } from "../libs/request";
import { buildNoStoreHeaders, jsonResponse, serveCachedAssetResponse } from "../libs/response";
import {
  deleteMiniAppGalleryImage,
  listMiniAppGalleryPage,
  readMiniAppGalleryFile,
  uploadMiniAppGalleryImage,
} from "../view/gallery";

/**
 * 处理 `GET /api/gallery`：分页返回当前配置图库目录中的图片元数据列表。
 * @param url 已解析的请求 URL（读取 `page`、`pageSize` 查询参数）。
 * @returns JSON 响应。
 */
export async function handleGetGalleryRoute(url: URL): Promise<Response> {
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
 * 处理 `GET|HEAD /api/gallery/download/:fileName`：在前置下载中间件链完成完整双层鉴权（跨站拦截 + 超管 `initData` 签名或资源令牌 + 45 分钟 `session` 会话令牌）后，经文件名安全校验返回带秒级时间戳文件名 `Content-Disposition: attachment` 下载头与 `no-store` 防缓存策略的图片原始二进制流。
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
