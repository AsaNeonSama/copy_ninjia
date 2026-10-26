import { buildProtectedAssetUrl } from "./request";

/**
 * 构造 `GET ./api/resources/svg/:fileName` 受保护 SVG 图标资源地址（携带受保护资源令牌，或回退携带 SuperAdmin `initData` 签名）。
 * @param fileName 服务端受保护 SVG 资源目录下的文件名（如 `"status.svg"`）
 * @returns 供受保护访问的 SVG 资源 URL
 */
export function buildMiniAppSvgResourceUrl(fileName: string): string {
  return buildProtectedAssetUrl("./api/resources/svg", fileName);
}
