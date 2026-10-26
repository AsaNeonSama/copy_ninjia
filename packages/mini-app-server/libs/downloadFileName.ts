/**
 * 构造以秒级 Unix 时间戳命名的图库图片下载文件名（保留原文件扩展名，如 `1792934000.png`），用于附件下载响应的 `Content-Disposition`。
 * 与 `packages/mini-app-frontend/libs/formatters.ts` 的同名函数输出一致，由 `test/miniApp/frontendParity.test.ts` 核对。
 * @param fileName 图库图片原始 SHA-256 文件名。
 * @param nowMs 可选当前毫秒时间戳（默认 `Date.now()`）。
 * @returns 秒级时间戳加扩展名的下载文件名。
 */
export function buildMiniAppGalleryDownloadFileName(
  fileName: string,
  nowMs: number = Date.now()
): string {
  const dotIndex: number = fileName.lastIndexOf(".");
  const ext: string =
    dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ".jpg";
  const timestampSec: number = Math.max(0, Math.floor(nowMs / 1000));
  return `${timestampSec}${ext}`;
}
