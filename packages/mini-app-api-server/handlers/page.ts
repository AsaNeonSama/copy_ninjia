import { miniAppServerHolder } from "../../cache/main/miniApp";
import { MINI_APP_FAVICON_PATH } from "../../consts/paths";
import { buildNoStoreHeaders, htmlResponse, jsonResponse, serveCachedAssetResponse } from "../libs/response";

/** 从 `Bun.serve` 的 `/_bundle` 路由读取并改写为相对路径后的入口 HTML 与打包资源根路径集合。 */
export interface BundledMiniAppIndex {
  /** 已将本地根路径资源引用（`<script src="/...">`、`<link href="/...">`）改写为 `./...` 的 HTML 文本。 */
  readonly html: string;
  /** 打包入口引用的本地资源原始根路径集合（如 `"/chunk-*.js"`、`"/chunk-*.css"`、`"/favicon-*.ico"`）。 */
  readonly assetPaths: ReadonlySet<string>;
}

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
 * 将元素上以单个 `/` 开头（排除 `//` 协议相对地址）的本地根路径属性值改写为 `./...` 相对路径，并将原始根路径记入集合。
 * @param element `HTMLRewriter` 匹配到的 HTML 元素。
 * @param attributeName 待检查与改写的属性名（`"src"` 或 `"href"`）。
 * @param assetPaths 收集原始本地根路径的可变集合。
 */
function rewriteRootRelativeAttribute(
  element: HTMLRewriterTypes.Element,
  attributeName: string,
  assetPaths: Set<string>
): void {
  const value: string | null = element.getAttribute(attributeName);
  if (value !== null && value.startsWith("/") && !value.startsWith("//")) {
    assetPaths.add(value);
    element.setAttribute(attributeName, `.${value}`);
  }
}

/**
 * 从当前运行中的 `Bun.serve` 实例拉取内部 `/_bundle` 路由，将入口 HTML 中引用的本地打包资源路径改写为 `./...` 相对路径，并返回改写后的 HTML 与原始资源根路径集合。
 * @returns 服务已启动且读取成功时返回 `{ html, assetPaths }`，否则返回 `null`。
 */
export async function readBundledMiniAppIndex(): Promise<Readonly<BundledMiniAppIndex> | null> {
  const activeServer: ReturnType<typeof Bun.serve> | null = miniAppServerHolder.current;
  if (activeServer === null) return null;
  try {
    const bundleUrl: URL = new URL("/_bundle", activeServer.url);
    const bundledRes: Response = await fetch(bundleUrl);
    if (!bundledRes.ok) return null;
    const rawHtml: string = await bundledRes.text();
    const assetPaths: Set<string> = new Set<string>();
    const rewriter: HTMLRewriter = new HTMLRewriter()
      .on("script[src]", {
        element(element: HTMLRewriterTypes.Element): void {
          rewriteRootRelativeAttribute(element, "src", assetPaths);
        },
      })
      .on("link[href]", {
        element(element: HTMLRewriterTypes.Element): void {
          rewriteRootRelativeAttribute(element, "href", assetPaths);
        },
      });
    const html: string = rewriter.transform(rawHtml);
    return { html, assetPaths };
  } catch (_error: unknown) {
    return null;
  }
}

/**
 * 读取 Mini App 入口 HTML 文本（当 `Bun.serve` 已启动时从内部 `/_bundle` 路由获取并将本地打包产物引用改写为 `./...` 相对路径；直接单元测试调用时读取源文件），并附带完整的 CSP 与 `X-Frame-Options` 响应头返回。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns 带完整安全响应头的 HTML `Response`。
 */
export async function serveMiniAppIndexHtml(
  indexHtml: Bun.HTMLBundle,
  headOnly: boolean
): Promise<Response> {
  const bundled: Readonly<BundledMiniAppIndex> | null = await readBundledMiniAppIndex();
  if (bundled !== null) {
    return htmlResponse(bundled.html, headOnly);
  }
  const htmlText: string = await Bun.file(indexHtml.index).text();
  return htmlResponse(htmlText, headOnly);
}

/**
 * 处理公开的 `GET /favicon.ico` 与 `HEAD /favicon.ico` 请求，直接按 `MINI_APP_FAVICON_PATH` 读取静态图标并允许浏览器与 CDN 缓存。
 * @param request HTTP 请求对象。
 * @returns `200 OK` 或 `304 Not Modified` 图标响应。
 */
export function handleGetFaviconRoute(request: Request): Response {
  const file: Bun.BunFile = Bun.file(MINI_APP_FAVICON_PATH);
  return serveCachedAssetResponse(request, file, {
    mimeType: "image/x-icon",
    sizeBytes: file.size,
    etag: `"favicon-ico-${file.size}"`,
  });
}
