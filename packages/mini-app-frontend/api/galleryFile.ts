import { buildProtectedAssetUrl } from "./request";

/**
 * 构造 `GET ./api/gallery/file/:fileName` 图库单张图片预览地址（携带受保护资源令牌，或回退携带 SuperAdmin `initData` 签名与 45 分钟会话令牌）。
 * @param fileName 图库图片文件名
 * @returns 供 `<img>` 使用的受保护预览 URL
 */
export function buildMiniAppGalleryImageUrl(fileName: string): string {
  return buildProtectedAssetUrl("./api/gallery/file", fileName);
}
