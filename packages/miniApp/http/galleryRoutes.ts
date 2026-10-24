import { MINI_APP_GALLERY_FILE_ROUTE_PATTERN } from "../../consts/miniApp";
import type { MiniAppGalleryUploadResult } from "../../types/miniApp";
import {
  listMiniAppGalleryPage,
  readMiniAppGalleryFile,
  uploadMiniAppGalleryImage,
} from "../galleryView";
import type { ResolvedMiniAppGalleryFile } from "../galleryView";
import {
  authenticateMiniAppRequest,
  buildNoStoreHeaders,
  jsonResponse,
  parseOptionalSafeInt,
} from "./common";

/**
 * 处理 `GET /api/gallery`：分页返回当前配置图库目录中的图片元数据列表。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
export async function handleGetGalleryRoute(request: Request): Promise<Response> {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  const url: URL = new URL(request.url);
  const page: number | undefined = parseOptionalSafeInt(url.searchParams.get("page"));
  const pageSize: number | undefined = parseOptionalSafeInt(
    url.searchParams.get("pageSize")
  );
  return jsonResponse(await listMiniAppGalleryPage(page, pageSize));
}

/**
 * 处理 `GET /api/gallery/file/:fileName`（及 `HEAD`）：在通过 SuperAdmin 鉴权与文件名安全校验后返回图片二进制流。
 * @param request HTTP 请求。
 * @param rawFileName URL 中的文件名参数。
 * @returns 图片文件响应或 `404` JSON 响应。
 */
export async function handleGetGalleryFileByName(
  request: Request,
  rawFileName: string
): Promise<Response> {
  if (
    request.headers.get("sec-fetch-dest") === "document" ||
    request.headers.get("sec-fetch-mode") === "navigate"
  ) {
    return jsonResponse(
      {
        ok: false,
        reason: "forbidden_user",
        error: "禁止从浏览器地址栏直接导航访问图库文件。",
      },
      403
    );
  }
  const rejected: Response | null = authenticateMiniAppRequest(request, true);
  if (rejected !== null) return rejected;
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  const headers: Record<string, string> = buildNoStoreHeaders(resolved.mimeType);
  headers["Content-Length"] = String(resolved.sizeBytes);
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
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
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
 * 兜底匹配并处理 `/api/gallery` 及其子路由。
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
  const fileMatch: RegExpExecArray | null =
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.exec(routePath);
  if (fileMatch !== null && (method === "GET" || method === "HEAD")) {
    return handleGetGalleryFileByName(request, fileMatch[1] ?? "");
  }
  return null;
}
