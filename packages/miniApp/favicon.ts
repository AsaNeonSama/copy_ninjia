import { buildAssetCacheHeaders } from "./http/common";

/**
 * 处理公开的 `GET /favicon.ico` 与 `HEAD /favicon.ico` 请求，直接返回 `packages/miniApp/miniAppResoures/favicon.ico` 静态图标并允许浏览器与 CDN 缓存。
 * @param request HTTP 请求对象。
 * @returns `200 OK` 或 `304 Not Modified` 图标响应。
 */
export function handleGetFaviconRoute(request: Request): Response {
  const faviconUrl: URL = new URL(
    "./miniAppResoures/favicon.ico",
    import.meta.url
  );
  const file: Bun.BunFile = Bun.file(faviconUrl);
  const etag: string = `"favicon-ico-${file.size}"`;
  const headers: Record<string, string> = buildAssetCacheHeaders(
    "image/x-icon",
    file.size,
    etag
  );
  const ifNoneMatch: string | null = request.headers.get("if-none-match");
  if (ifNoneMatch !== null && ifNoneMatch.trim() === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method.toUpperCase() === "HEAD" ? null : file, {
    status: 200,
    headers,
  });
}
