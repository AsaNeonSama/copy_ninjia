import {
  miniAppBundledAssetsHolder,
  miniAppBundledAssetsPromiseHolder,
  miniAppRejectHtmlHolder,
} from "../../cache/main/miniApp";
import { MINI_APP_REJECT_HTML_BODY_TAG } from "../../consts/miniApp";
import {
  MINI_APP_FAVICON_PATH,
  MINI_APP_REJECT_HTML_PATH,
} from "../../consts/paths";
import { logger } from "../../infra/logger";
import type { MiniAppAccessDiagnostics } from "../../types/miniApp/auth";
import type {
  BundledMiniAppAsset,
  BundledMiniAppAssets,
  MiniAppRejectHtmlTemplate,
} from "../../types/miniApp/server";
import {
  attachClearMiniAppPageGateCookie,
  attachMiniAppPageGateCookie,
  evaluateMiniAppPageGateRequest,
} from "../auth/pageGate";
import type { MiniAppPageGateDecision } from "../auth/pageGate";
import {
  buildMiniAppAccessDiagnostics,
  buildNoStoreHeaders,
  htmlResponse,
  jsonResponse,
  serveCachedAssetResponse,
} from "../libs/response";
import type { BuildMiniAppAccessDiagnosticsParams } from "../libs/response";

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
 * 启动短暂本地回环 `Bun.serve` 实例提取 `Bun.HTMLBundle` 的入口 HTML 与全部本地打包产物，提取完成后立即停止该临时实例。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 物化成功时返回只读快照，失败时返回 `null`。
 */
async function runMaterializeBundledMiniAppAssets(
  indexHtml: Bun.HTMLBundle
): Promise<Readonly<BundledMiniAppAssets> | null> {
  let tempServer: ReturnType<typeof Bun.serve> | null = null;
  try {
    tempServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      routes: { "/_bundle": indexHtml },
      fetch(): Response {
        return new Response(null, { status: 404 });
      },
    });
    const bundledRes: Response = await fetch(new URL("/_bundle", tempServer.url));
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
    const assets: Map<string, Readonly<BundledMiniAppAsset>> = new Map<
      string,
      Readonly<BundledMiniAppAsset>
    >();
    for (const assetPath of assetPaths) {
      const assetRes: Response = await fetch(new URL(assetPath, tempServer.url));
      if (!assetRes.ok) return null;
      const content: Uint8Array = await assetRes.bytes();
      const rawContentType: string = assetRes.headers.get("content-type")?.trim() ?? "";
      const contentType: string =
        rawContentType.length > 0 ? rawContentType : "application/octet-stream";
      const rawEtag: string = assetRes.headers.get("etag")?.trim() ?? "";
      const etag: string =
        rawEtag.length > 0 ? rawEtag : `"${Bun.SHA256.hash(content, "hex")}"`;
      assets.set(assetPath, {
        content,
        contentType,
        etag,
      });
    }
    const materialized: Readonly<BundledMiniAppAssets> = {
      html,
      assets,
    };
    miniAppBundledAssetsHolder.current = materialized;
    return materialized;
  } catch (error: unknown) {
    logger.error("Failed to materialize Mini App HTML bundle:", error);
    return null;
  } finally {
    if (tempServer !== null) {
      await tempServer.stop(true);
    }
  }
}

/**
 * 按需一次性物化并缓存 Mini App 前端入口 HTML 与本地打包静态资源映射（并发首次请求共享同一个在途任务）。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 已物化的只读打包快照；物化失败时返回 `null`。
 */
export async function materializeBundledMiniAppAssets(
  indexHtml: Bun.HTMLBundle
): Promise<Readonly<BundledMiniAppAssets> | null> {
  if (miniAppBundledAssetsHolder.current !== null) {
    return miniAppBundledAssetsHolder.current;
  }
  if (miniAppBundledAssetsPromiseHolder.current !== null) {
    return miniAppBundledAssetsPromiseHolder.current;
  }
  const task: Promise<Readonly<BundledMiniAppAssets> | null> =
    runMaterializeBundledMiniAppAssets(indexHtml);
  miniAppBundledAssetsPromiseHolder.current = task;
  try {
    return await task;
  } finally {
    if (miniAppBundledAssetsPromiseHolder.current === task) {
      miniAppBundledAssetsPromiseHolder.current = null;
    }
  }
}

/**
 * 按唯一 `<body>` 起始标签预切分未授权拒绝页静态 HTML 模板。
 * 模板必须且仅能出现一次 `<body>`，缺失或重复时直接抛出异常。
 * @param rawHtml 从 `MINI_APP_REJECT_HTML_PATH` 读取的原始模板 HTML 文本。
 * @returns 拆分为 `<body` 前缀与 `>` 后缀的只读静态模板对象。
 */
export function parseMiniAppRejectHtmlTemplate(
  rawHtml: string
): Readonly<MiniAppRejectHtmlTemplate> {
  const bodyIndex: number = rawHtml.indexOf(MINI_APP_REJECT_HTML_BODY_TAG);
  if (bodyIndex === -1) {
    throw new Error("Mini App reject HTML template is missing <body> tag.");
  }
  if (
    rawHtml.includes(
      MINI_APP_REJECT_HTML_BODY_TAG,
      bodyIndex + MINI_APP_REJECT_HTML_BODY_TAG.length
    )
  ) {
    throw new Error("Mini App reject HTML template contains duplicate <body> tags.");
  }
  // 拆到 "<body" 末尾，tail 从 ">" 开始，避免每次请求重复拼接开标签前缀。
  const splitOffset: number = bodyIndex + MINI_APP_REJECT_HTML_BODY_TAG.length - 1;
  return {
    head: rawHtml.slice(0, splitOffset),
    tail: rawHtml.slice(splitOffset),
  };
}

/**
 * 读取进程内缓存的独立 `reject.html` 预切分模板（首次非 `HEAD` 访问时从磁盘加载并按唯一 `<body>` 切分），
 * 将本次请求的真实访问拒绝诊断 `data-*` 属性转义后直接拼接到 `<body ...>` 中（绝不改动内联 `<script>`），
 * 并以 `200 OK` 防缓存响应头返回。
 * 外部浏览器、跨站/直接导航请求及非超级管理员访问 Mini App 入口均只返回本拒绝页，不加载完整前端包，不泄露任何业务数据。
 * @param request HTTP 请求对象。
 * @param diagParams 状态码、错误代号与可选剩余锁定分钟数。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns 携带完整 CSP、`X-Frame-Options` 与 `X-Request-Id` 的独立拒绝页 `Response`。
 */
export async function serveMiniAppRejectHtml(
  request: Request,
  diagParams: Readonly<BuildMiniAppAccessDiagnosticsParams>,
  headOnly: boolean
): Promise<Response> {
  const diag: Readonly<MiniAppAccessDiagnostics> = buildMiniAppAccessDiagnostics(
    request,
    diagParams
  );
  const headers: Record<string, string> = buildNoStoreHeaders(
    "text/html; charset=utf-8",
    diag.requestId
  );
  if (headOnly) {
    return new Response(null, { status: 200, headers });
  }
  let template: Readonly<MiniAppRejectHtmlTemplate> | null =
    miniAppRejectHtmlHolder.current;
  if (template === null) {
    const rawRejectHtml: string = await Bun.file(MINI_APP_REJECT_HTML_PATH).text();
    template = parseMiniAppRejectHtmlTemplate(rawRejectHtml);
    miniAppRejectHtmlHolder.current = template;
  }
  const remainingMinutesAttr: string =
    diag.remainingMinutes !== undefined
      ? ` data-remaining-minutes="${Bun.escapeHTML(String(diag.remainingMinutes))}"`
      : "";
  const html: string =
    `${template.head}` +
    ` data-status="${Bun.escapeHTML(String(diag.status))}"` +
    ` data-code="${Bun.escapeHTML(diag.code)}"` +
    ` data-error="${Bun.escapeHTML(diag.error)}"` +
    ` data-request-id="${Bun.escapeHTML(diag.requestId)}"` +
    ` data-timestamp="${Bun.escapeHTML(diag.timestamp)}"` +
    ` data-client-ip="${Bun.escapeHTML(diag.clientIp)}"` +
    ` data-host="${Bun.escapeHTML(diag.host)}"` +
    ` data-path="${Bun.escapeHTML(diag.path)}"` +
    `${remainingMinutesAttr}${template.tail}`;
  return new Response(html, { status: 200, headers });
}

/**
 * 处理单页入口路由（`GET`/`HEAD` `/`、`/index.html` 及其子路径别名）：
 * 仅在携带合法超级管理员 `initData` 请求头或有效门禁 Cookie 且未处于密码锁定期时返回物化后的完整前端入口 HTML；
 * 其余未授权状态一律返回独立 `reject.html`，绝不返回完整前端包。
 * @param request HTTP 请求对象。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns 单页入口或独立拒绝页 `Response`。
 */
export async function handleGetMiniAppPageRoute(
  request: Request,
  indexHtml: Bun.HTMLBundle,
  headOnly: boolean
): Promise<Response> {
  const decision: MiniAppPageGateDecision = evaluateMiniAppPageGateRequest(request);
  if (!decision.allowed) {
    const rejectResponse: Response = await serveMiniAppRejectHtml(
      request,
      decision.diagParams,
      headOnly
    );
    return decision.clearGateCookie
      ? attachClearMiniAppPageGateCookie(rejectResponse, request)
      : rejectResponse;
  }

  const bundled: Readonly<BundledMiniAppAssets> | null =
    await materializeBundledMiniAppAssets(indexHtml);
  if (bundled === null) {
    return headOnly
      ? new Response(null, { status: 500, headers: buildNoStoreHeaders() })
      : jsonResponse({ error: "Internal server error" }, 500);
  }
  const pageResponse: Response = htmlResponse(bundled.html, headOnly);
  return decision.issueGateCookie
    ? attachMiniAppPageGateCookie(pageResponse, request)
    : pageResponse;
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
    etag: `"favicon-ico-${file.size}-${file.lastModified}"`,
  });
}
