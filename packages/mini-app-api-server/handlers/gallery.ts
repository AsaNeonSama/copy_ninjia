import { MINI_APP_DOWNLOAD_TICKET_PARAM } from "../../consts/miniAppCrypto";
import { logger } from "../../infra/logger";
import type {
  MiniAppGalleryDeleteResult,
  MiniAppGalleryDownloadTicketRecord,
  MiniAppGalleryDownloadTicketResponse,
  MiniAppGalleryUploadResult,
  ResolvedMiniAppGalleryFile,
} from "../../types/miniApp/gallery";
import type { MiniAppRouteContext } from "../../types/miniApp/server";
import {
  issueMiniAppGalleryDownloadTicket,
  resolveMiniAppGalleryDownloadTicket,
  revokeMiniAppGalleryDownloadTicketsForFile,
} from "../auth/downloadTicket";
import { checkSuperAdminPasswordLockout } from "../auth/lockout";
import { hasActiveMiniAppAuthSessionByLineage } from "../auth/session";
import { buildMiniAppGalleryDownloadFileName } from "../libs/downloadFileName";
import {
  parseOptionalSafeInt,
  parseStrictSingleQueryParam,
  readJsonObjectBody,
} from "../libs/request";
import {
  accessErrorResponse,
  buildNoStoreHeaders,
  jsonResponse,
  serveGalleryFileResponse,
} from "../libs/response";
import { verifyMiniAppDownloadTicketHeaders } from "../middleware/headerGuard";
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
 * 处理 `GET|HEAD /api/gallery/file`：在 `MINI_APP_GALLERY_FILE_AUTH_POLICY`（双层会话鉴权 + `?e=` 查询串解封）通过后，读取并校验 `fileName` 查询参数，
 * 以 7 天私有协商缓存（`private, no-cache, max-age=604800, must-revalidate`、`CDN-Cache-Control: no-store` 与按鉴权头隔离的 `Vary`）返回图片流（命中 `If-None-Match` 时返回不含实体头的 `304 Not Modified`）。
 * @param request HTTP 请求。
 * @param url 已解封加密查询串后的请求 URL（读取 `fileName` 查询参数）。
 * @returns 图片文件响应、`304` 缓存命中响应或 `404` JSON 响应。
 */
export async function handleGetGalleryFileRoute(
  request: Request,
  url: URL
): Promise<Response> {
  const rawFileName: string = url.searchParams.get("fileName")?.trim() ?? "";
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  return serveGalleryFileResponse(request, Bun.file(resolved.filePath), resolved);
}

/**
 * 构造图库文件附件下载响应（供会话 `?e=` 加密下载路径与 60 秒一次性 `?ticket=` 原生下载路径复用）。
 * @param request HTTP 请求对象。
 * @param resolved 已校验的图库文件元数据。
 * @param downloadFileName `Content-Disposition` 中的安全下载文件名。
 * @returns 带 `no-store` 与 `Content-Disposition: attachment` 的二进制或 `HEAD` 空体响应。
 */
function buildGalleryDownloadFileResponse(
  request: Request,
  resolved: Readonly<ResolvedMiniAppGalleryFile>,
  downloadFileName: string
): Response {
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
 * 处理 `POST /api/gallery/download-ticket`：在完整双层会话鉴权通过后，校验请求体中的 `fileName` 对应图片存在，
 * 为当前活跃会话谱系签发一枚 60 秒有效的单次消费下载票据 `{ ticket, expiresAt, downloadFileName }`。
 * @param request 已解封外层加密信封的 HTTP 请求。
 * @param committedSessionLineageId 鉴权提交阶段确认的当前会话内部谱系标识。
 * @returns 下载票据 JSON 响应（`404` 时图片不存在）。
 */
export async function handlePostGalleryDownloadTicketRoute(
  request: Request,
  committedSessionLineageId?: string
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const rawFileName: string =
    typeof body?.fileName === "string" ? body.fileName.trim() : "";
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  if (
    committedSessionLineageId === undefined ||
    committedSessionLineageId.length === 0
  ) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "SESSION_EXPIRED",
    });
  }
  const downloadFileName: string = buildMiniAppGalleryDownloadFileName(
    resolved.fileName
  );
  const record: Readonly<MiniAppGalleryDownloadTicketRecord> =
    issueMiniAppGalleryDownloadTicket({
      sessionLineageId: committedSessionLineageId,
      fileName: resolved.fileName,
      downloadFileName,
    });
  logger.operation("[MiniApp] gallery.downloadTicket", {
    file: resolved.fileName,
    ok: true,
  });
  const payload: MiniAppGalleryDownloadTicketResponse = {
    ok: true,
    ticket: record.ticket,
    expiresAt: record.expiresAt,
    downloadFileName: record.downloadFileName,
  };
  return jsonResponse(payload);
}

/**
 * 处理 `GET|HEAD /api/gallery/download?ticket=<64-hex>`：在不依赖前端自定义请求头的前提下，
 * 依次核验跨站/同源请求头与 30 分钟密码锁定期，严格校验唯一 `?ticket=` 查询参数及其绑定的活跃会话谱系，
 * `GET` 时即刻消费作废该票据并返回附件文件流，`HEAD` 时仅探测而不消耗票据。
 * @param ctx 路由请求上下文。
 * @returns 附件下载文件响应、`401`/`403` 鉴权失败响应或 `404` 响应。
 */
export async function handleTicketDownloadGalleryFileRoute(
  ctx: Readonly<MiniAppRouteContext>
): Promise<Response> {
  const headerError: Response | null = verifyMiniAppDownloadTicketHeaders(ctx);
  if (headerError !== null) {
    return headerError;
  }
  const nowMs: number = Date.now();
  const lockout: Response | null = checkSuperAdminPasswordLockout(ctx.request, nowMs);
  if (lockout !== null) {
    return lockout;
  }
  const ticketValue: string | null = parseStrictSingleQueryParam(
    ctx.url,
    MINI_APP_DOWNLOAD_TICKET_PARAM
  );
  const ticketRecord: Readonly<MiniAppGalleryDownloadTicketRecord> | null =
    ticketValue !== null
      ? resolveMiniAppGalleryDownloadTicket({
        ticket: ticketValue,
        consume: ctx.method === "GET",
        isSessionActive: (sessionLineageId: string): boolean =>
          hasActiveMiniAppAuthSessionByLineage(sessionLineageId, nowMs),
        nowMs,
      })
      : null;
  if (ticketRecord === null) {
    return accessErrorResponse(ctx.request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "SESSION_EXPIRED",
    });
  }
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(ticketRecord.fileName);
  if (resolved === null) {
    revokeMiniAppGalleryDownloadTicketsForFile(ticketRecord.fileName);
    return jsonResponse({ error: "Image not found" }, 404);
  }
  return buildGalleryDownloadFileResponse(
    ctx.request,
    resolved,
    ticketRecord.downloadFileName
  );
}

/**
 * 处理 `GET|HEAD /api/gallery/download`（带请求头双层会话鉴权与 `?e=` 加密查询串）：读取并校验 `fileName` 查询参数，
 * 以秒级时间戳 `Content-Disposition: attachment` 及 `no-store` 防缓存头返回原图二进制流（供不支持原生下载时的 `blob:` 回退链路使用）。
 * @param request HTTP 请求对象。
 * @param url 已解封加密查询串后的请求 URL（读取 `fileName` 查询参数）。
 * @returns 附件下载图片文件响应或 `404` JSON 响应。
 */
export async function handleDownloadGalleryFileRoute(
  request: Request,
  url: URL
): Promise<Response> {
  const rawFileName: string = url.searchParams.get("fileName")?.trim() ?? "";
  const resolved: Readonly<ResolvedMiniAppGalleryFile> | null =
    await readMiniAppGalleryFile(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "Image not found" }, 404);
  }
  const downloadFileName: string = buildMiniAppGalleryDownloadFileName(
    resolved.fileName
  );
  return buildGalleryDownloadFileResponse(request, resolved, downloadFileName);
}

/**
 * 处理 `POST /api/gallery/upload`：按现有 `/h_image add` 的字节上限、魔数格式、像素尺寸与 SHA-256 协议将上传的图片写入图库目录（请求体已由鉴权管道校验会话密钥并解密还原为原始图片字节）。
 * @param request 已由鉴权管道解密还原图片原始字节的 HTTP 请求。
 * @returns 上传入库结果 JSON 响应。
 */
export async function handlePostGalleryUploadRoute(
  request: Request
): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await request.bytes();
  } catch (_error: unknown) {
    logger.operation("[MiniApp] gallery.upload", { outcome: "readFailed", ok: false });
    return jsonResponse(
      {
        ok: false,
        outcome: "failed",
        message: "GALLERY_UPLOAD_READ_FAILED",
      },
      400
    );
  }
  const result: Readonly<MiniAppGalleryUploadResult> =
    await uploadMiniAppGalleryImage(bytes);
  logger.operation(
    "[MiniApp] gallery.upload",
    result.ok
      ? {
        outcome: result.outcome,
        file: result.fileName ?? null,
        sizeBytes: bytes.byteLength,
        ok: true,
      }
      : {
        outcome: result.outcome,
        ok: false,
      }
  );
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * 处理 `POST /api/gallery/delete`：按已解密 JSON 请求体中的 `fileName` 从图库目录删除指定图片文件。
 * @param request HTTP 请求。
 * @returns 删除结果 JSON 响应。
 */
export async function handlePostGalleryDeleteRoute(
  request: Request
): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const fileName: string =
    typeof body?.fileName === "string" ? body.fileName.trim() : "";
  const result: Readonly<MiniAppGalleryDeleteResult> =
    await deleteMiniAppGalleryImage(fileName);
  if (result.fileName !== undefined && (result.ok || result.outcome === "notFound")) {
    revokeMiniAppGalleryDownloadTicketsForFile(result.fileName);
  }
  logger.operation("[MiniApp] gallery.delete", {
    file: result.fileName ?? null,
    outcome: result.outcome,
    ok: result.ok,
  });
  const status: number = result.ok
    ? 200
    : result.outcome === "notFound"
      ? 404
      : 400;
  return jsonResponse(result, status);
}
