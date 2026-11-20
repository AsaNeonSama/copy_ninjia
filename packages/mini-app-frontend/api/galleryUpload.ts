import { buildMiniAppEnvelopeAad, encryptMiniAppBinary } from "../libs/crypto";
import { asPayloadRecord } from "../libs/record";
import type { MiniAppGalleryUploadResult } from "../types/miniApp/gallery";
import { throwMiniAppRecordError } from "./authError";
import {
  buildMiniAppAuthHeaders,
  decodeAndSyncEncryptedMiniAppResponse,
  resolveMiniAppSessionCryptoSnapshot,
} from "./request";
import type { MiniAppSessionCryptoSnapshot } from "./request";

/**
 * 调用 `POST ./api/gallery/upload`，按现有 `/h_image add` 协议上传单张图片（使用当前会话 256-bit AES-GCM 密钥将原始图片字节加密为 `[12B IV || 密文+16B 标签]` 并绑定 `POST /api/gallery/upload:req` AAD；本地缺少会话密钥时拦截请求并触发重新认证；JSON 响应信封经会话密钥解密校验后再同步滑动续期）。
 * 响应体解密/轮换密钥解封失败或非 2xx 且未携带业务 `outcome` 时抛出 `Error`：命中会话失效、加密载荷失效、HTTP `401` 或访问拒绝状态码时先清除本地会话凭据并附加 `[代号] ` 前缀。
 *
 * @param bytes 待上传的图片原始字节
 * @returns 结构化的上传入库结果
 */
export async function uploadMiniAppGalleryImageBytes(
  bytes: Uint8Array
): Promise<MiniAppGalleryUploadResult> {
  const { sentSessionToken, cryptoKeyAtSend }: MiniAppSessionCryptoSnapshot =
    await resolveMiniAppSessionCryptoSnapshot();
  const encryptedBody: Uint8Array<ArrayBuffer> = await encryptMiniAppBinary(
    cryptoKeyAtSend,
    bytes,
    buildMiniAppEnvelopeAad("POST", "/api/gallery/upload", "req")
  );
  const response: Response = await fetch("./api/gallery/upload", {
    method: "POST",
    headers: buildMiniAppAuthHeaders(
      true,
      "application/octet-stream",
      sentSessionToken
    ),
    body: encryptedBody,
  });
  const payload: unknown = await decodeAndSyncEncryptedMiniAppResponse({
    response,
    cryptoKeyAtSend,
    sentSessionToken,
    additionalData: buildMiniAppEnvelopeAad("POST", "/api/gallery/upload", "res"),
  });
  const record: Record<string, unknown> = asPayloadRecord(payload);
  if (typeof record.outcome === "string" && typeof record.message === "string") {
    return payload as MiniAppGalleryUploadResult;
  }
  if (!response.ok) {
    throwMiniAppRecordError(payload, response.status, sentSessionToken);
  }
  return { ok: false, outcome: "failed", message: "GALLERY_UPLOAD_FAILED" };
}
