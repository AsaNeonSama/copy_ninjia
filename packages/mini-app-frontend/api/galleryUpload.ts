import { asPayloadRecord } from "../libs/record";
import type { MiniAppGalleryUploadResult } from "../types/miniApp";
import {
  buildMiniAppAuthHeaders,
  consumeMiniAppAuthErrorPrefix,
  syncRefreshedMiniAppSession,
} from "./request";

/**
 * 调用 `POST ./api/gallery/upload`，按现有 `/h_image add` 协议（字节上限、魔数格式、像素尺寸与内容 SHA-256 去重）上传单张图片到图库目录。
 * 非 2xx 且未携带业务 `outcome` 时抛出 `Error`：会话缺失或锁定（`PASSWORD_REQUIRED` / `PASSWORD_LOCKED`）时先清除本地会话令牌并带 `[代号] ` 前缀。
 * @param bytes 待上传的图片原始字节
 * @returns 结构化的上传入库结果
 */
export async function uploadMiniAppGalleryImageBytes(
  bytes: Uint8Array
): Promise<MiniAppGalleryUploadResult> {
  const response: Response = await fetch("./api/gallery/upload", {
    method: "POST",
    headers: buildMiniAppAuthHeaders(true, "application/octet-stream"),
    body: bytes,
  });
  syncRefreshedMiniAppSession(response);
  const payload: unknown = await response.json().catch((): null => null);
  const record: Record<string, unknown> = asPayloadRecord(payload);
  if (typeof record.outcome === "string" && typeof record.message === "string") {
    return payload as MiniAppGalleryUploadResult;
  }
  if (!response.ok) {
    const prefix: string = consumeMiniAppAuthErrorPrefix(record);
    const errText: string =
      typeof record.error === "string"
        ? record.error
        : typeof record.message === "string"
          ? record.message
          : `HTTP ${response.status}`;
    throw new Error(`${prefix}${errText}`, { cause: record });
  }
  return { ok: false, outcome: "failed", message: "GALLERY_UPLOAD_FAILED" };
}
