import { miniAppServerHolder } from "../../cache/main/miniApp";
import { openMiniAppResourceFile } from "../libs/resource";
import { buildNoStoreHeaders, htmlResponse, jsonResponse, serveCachedAssetResponse } from "../libs/response";

/**
 * 处理公开的 `GET /healthz` 与 `HEAD /healthz` 存活探测。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns `GET` 返回 `{ ok: true }` JSON，`HEAD` 返回无响应体的 `200`。
 */
export function handleHealthzRoute(headOnly: boolean): Response {
  return headOnly
    ? new Response(null, { status: 200, headers: buildNoStoreHeaders() })
    : jsonResponse({ ok: true });
}

/**
 * 读取 Mini App 入口 HTML 文本（当 `Bun.serve` 已启动时从内部 `/_bundle` 路由获取注入了打包产物路径的 HTML；直接单元测试调用时读取源文件），并附带完整的 CSP 与 `X-Frame-Options` 响应头返回。
 * @param indexHtml `routes.ts` 以 HTML import 引入的前端入口。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns 带完整安全响应头的 HTML `Response`。
 */
export async function serveMiniAppIndexHtml(
  indexHtml: Bun.HTMLBundle,
  headOnly: boolean
): Promise<Response> {
  const activeServer: ReturnType<typeof Bun.serve> | null = miniAppServerHolder.current;
  if (activeServer !== null) {
    try {
      const bundleUrl: URL = new URL("/_bundle", activeServer.url);
      const bundledRes: Response = await fetch(bundleUrl);
      if (bundledRes.ok) {
        const bundledHtml: string = await bundledRes.text();
        return htmlResponse(bundledHtml, headOnly);
      }
    } catch (_error: unknown) {
      // 回退至直接读取源 HTML 文件
    }
  }
  const htmlText: string = await Bun.file(indexHtml.index).text();
  return htmlResponse(htmlText, headOnly);
}

/**
 * 处理公开的 `GET /favicon.ico` 与 `HEAD /favicon.ico` 请求，直接返回 `packages/mini-app-server/resource/favicon.ico` 静态图标并允许浏览器与 CDN 缓存。
 * @param request HTTP 请求对象。
 * @returns `200 OK` 或 `304 Not Modified` 图标响应。
 */
export function handleGetFaviconRoute(request: Request): Response {
  const file: Bun.BunFile = openMiniAppResourceFile("favicon.ico");
  return serveCachedAssetResponse(request, file, {
    mimeType: "image/x-icon",
    sizeBytes: file.size,
    etag: `"favicon-ico-${file.size}"`,
  });
}
