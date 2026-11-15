import { buildProtectedAssetUrl } from "./request";

/**
 * 构造 `GET ./api/gallery/file/:fileName` 图库图片预览 URL（优先携带受保护资源令牌，未下发时回退携带 `initData` 与 45 分钟二次认证会话令牌）。
 * @param fileName 图库图片文件名
 * @returns 供 `<img>` 使用的受保护预览 URL
 */
export function buildMiniAppGalleryImageUrl(fileName: string): string {
  return buildProtectedAssetUrl("./api/gallery/file", fileName);
}
