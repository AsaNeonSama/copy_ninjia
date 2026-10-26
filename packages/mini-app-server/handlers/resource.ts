import type { ResolvedMiniAppSvgResource } from "../../types/miniApp";
import { readMiniAppSvgResource } from "../libs/resource";
import { jsonResponse, serveCachedAssetResponse } from "../libs/response";

/**
 * 处理 `GET /api/resources/svg/:fileName` 与 `GET /miniAppResoures/:fileName`（及 `HEAD`）：在前置受保护资源中间件链完成 Telegram WebApp 签名或资源令牌、超管 ID 与防直接导航核验后，返回允许浏览器与 CDN 缓存的 SVG 图标流（或命中 `If-None-Match` 时返回 `304 Not Modified`）。
 * @param request HTTP 请求。
 * @param rawFileName URL 中的 SVG 文件名参数。
 * @returns SVG 响应、`304` 缓存命中响应或 `404` JSON 响应。
 */
export async function handleGetSvgResourceByName(
  request: Request,
  rawFileName: string
): Promise<Response> {
  const resolved: Readonly<ResolvedMiniAppSvgResource> | null =
    await readMiniAppSvgResource(rawFileName);
  if (resolved === null) {
    return jsonResponse({ error: "SVG resource not found" }, 404);
  }
  return serveCachedAssetResponse(request, resolved.file, resolved);
}
