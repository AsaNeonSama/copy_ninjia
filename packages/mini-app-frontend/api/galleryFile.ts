import {
  evictCachedMiniAppGalleryImage,
  readCachedMiniAppGalleryImage,
  writeCachedMiniAppGalleryImage,
} from "../libs/galleryImageCache";
import type { CachedGalleryBinaryEntry } from "../types/miniApp/gallery";
import { throwMiniAppRecordError } from "./authError";
import {
  buildMiniAppAuthHeaders,
  prepareEncryptedMiniAppQueryRequest,
  syncRefreshedMiniAppSession,
} from "./request";
import type { PreparedEncryptedMiniAppQueryRequest } from "./request";

/**
 * 在请求取消信号已触发时抛出标准 `AbortError`，避免在异步查询加密或读取本地协商缓存前后继续派发陈旧网络请求。
 *
 * @param signal 可选 `AbortSignal`
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

/**
 * 以已认证加密查询参数请求 `GET ./api/gallery/file?e=...` 拉取单张图库图片二进制流，
 * 并通过独立于 `?e=` 加密请求 URL 的本地 7 天持久化与内存 `ETag` 协商缓存实现跨会话增量复用：
 * - 先读取本地 7 天持久化/内存缓存，再校验并封装加密查询串与发出时的会话令牌快照（未解锁或会话过期时立即抛出 `[PASSWORD_REQUIRED]`，防止异步读缓存期间发生的令牌轮换导致发包携带过期密文）；
 * - 若本地存在未满 7 天且带 `ETag` 的缓存条目，则以 `cache: "no-store"` 附带 `If-None-Match` 向服务端复核鉴权与文件 `ETag`；
 * - 服务端返回 `304 Not Modified` 时直接复用本地缓存 `Blob` 生成 `blob:` URL（不刷新 7 天初始写入时刻，确保满 1 周后强制重拉）；
 * - 服务端返回 `200 OK` 时按响应 `ETag` 更新本地 `Blob` 缓存（响应缺失 `ETag` 时同步驱逐旧缓存）并返回新 `blob:` URL；返回 `404` 时立即驱逐陈旧缓存条目；
 * - 命中会话失效、加密载荷失效、HTTP `401` 或门禁访问拒绝状态码时按令牌一致性清除本地会话凭据且在消息前加 `[代号] ` 前缀；若 `signal` 在准备、读取缓存或等待响应落定期间中止，直接拒绝为 `AbortError`。
 *
 * @param fileName 图库图片文件名
 * @param signal 可选 `AbortSignal`，用于切页或组件卸载时取消在途请求
 * @returns 已就绪的 `blob:` 图片对象 URL
 */
export async function fetchMiniAppGalleryImageObjectUrl(
  fileName: string,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);
  const cachedEntry: Readonly<CachedGalleryBinaryEntry> | null =
    await readCachedMiniAppGalleryImage(fileName);
  throwIfAborted(signal);
  const rawQuery: string = `fileName=${encodeURIComponent(fileName)}`;
  const {
    outboundPath,
    sentSessionToken,
  }: PreparedEncryptedMiniAppQueryRequest =
    await prepareEncryptedMiniAppQueryRequest(
      "./api/gallery/file",
      rawQuery,
      "GET"
    );
  throwIfAborted(signal);
  const headers: Record<string, string> = buildMiniAppAuthHeaders(
    true,
    undefined,
    sentSessionToken
  );
  if (cachedEntry !== null) {
    headers["If-None-Match"] = cachedEntry.etag;
  }
  const response: Response = await fetch(outboundPath, {
    method: "GET",
    cache: "no-store",
    headers,
    ...(signal !== undefined ? { signal } : {}),
  });
  syncRefreshedMiniAppSession(response);
  if (response.status === 304 && cachedEntry !== null) {
    throwIfAborted(signal);
    return URL.createObjectURL(cachedEntry.blob);
  }
  if (!response.ok) {
    if (response.status === 404) {
      await evictCachedMiniAppGalleryImage(fileName);
    }
    const payload: unknown = await response.json().catch((): null => null);
    throwMiniAppRecordError(payload, response.status, sentSessionToken);
  }
  const blob: Blob = await response.blob();
  throwIfAborted(signal);
  const etag: string = response.headers.get("etag")?.trim() ?? "";
  if (etag.length > 0) {
    await writeCachedMiniAppGalleryImage({ fileName, blob, etag });
  } else if (cachedEntry !== null) {
    await evictCachedMiniAppGalleryImage(fileName);
  }
  throwIfAborted(signal);
  return URL.createObjectURL(blob);
}
