import {
  miniAppBundledAssetsHolder,
  miniAppBundledAssetsPromiseHolder,
  miniAppRejectHtmlHolder,
  miniAppRuntimeSigningKeyHolder,
} from "../../cache/main/miniApp";
import { MINI_APP_REJECT_HTML_BODY_TAG } from "../../consts/miniApp";
import {
  MINI_APP_ED25519_PUBLIC_KEY_BYTES,
  MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER,
} from "../../consts/miniAppCrypto";
import {
  MINI_APP_FAVICON_PATH,
  MINI_APP_REJECT_HTML_PATH,
} from "../../consts/paths";
import { logger } from "../../infra/logger";
import type {
  MiniAppAccessDiagnostics,
  MiniAppRuntimeSigningKeyPair,
} from "../../types/miniApp/auth";
import type {
  BundledMiniAppAsset,
  BundledMiniAppAssets,
  MiniAppRejectHtmlTemplate,
} from "../../types/miniApp/server";
import { ensureMiniAppRuntimeSigningKeyPair } from "../auth/handshake";
import {
  attachClearMiniAppPageGateCookie,
  attachMiniAppPageGateCookie,
  evaluateMiniAppPageGateRequest,
} from "../auth/pageGate";
import type { MiniAppPageGateDecision } from "../auth/pageGate";
import { decodeMiniAppBase64Bytes } from "../libs/crypto";
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

const STRICT_UTF8_DECODER: TextDecoder = new TextDecoder("utf-8", {
  fatal: true,
});
const UTF8_ENCODER: TextEncoder = new TextEncoder();

/**
 * 判断物化出的前端打包资源路径或 MIME 类型是否为 JavaScript 模块产物。
 * @param assetPath 打包资源路径。
 * @param contentType 打包响应 `Content-Type` 头部文本。
 * @returns 为 JS/MJS 资源时返回 `true`。
 */
function isJavaScriptBundleAsset(assetPath: string, contentType: string): boolean {
  return (
    contentType.toLowerCase().includes("javascript") ||
    assetPath.endsWith(".js") ||
    assetPath.endsWith(".mjs")
  );
}

/**
 * 启动短暂本地回环 `Bun.serve` 实例提取 `Bun.HTMLBundle` 的入口 HTML 与全部本地打包产物，
 * 将本次启动内存生成的 32 字节 Ed25519 验签公钥注入打包 JS 产物并重算 ETag，提取完成后立即停止该临时实例。
 * @param indexHtml `server/register.ts` 以 HTML import 引入的前端入口。
 * @returns 物化成功时返回只读快照，失败或期间发生服务启停切换时返回 `null`。
 */
async function runMaterializeBundledMiniAppAssets(
  indexHtml: Bun.HTMLBundle
): Promise<Readonly<BundledMiniAppAssets> | null> {
  let expectedSigningKeyPromise: Promise<Readonly<MiniAppRuntimeSigningKeyPair>>;
  let runtimePublicKeyBase64: string;
  try {
    expectedSigningKeyPromise = ensureMiniAppRuntimeSigningKeyPair();
    const runtimeSigningKey: Readonly<MiniAppRuntimeSigningKeyPair> =
      await expectedSigningKeyPromise;
    runtimePublicKeyBase64 = runtimeSigningKey.publicKeyBase64.trim();
  } catch (error: unknown) {
    logger.error("Cannot generate Mini App Ed25519 signing public key for bundle:", error);
    return null;
  }
  const decodedPublicKey: Uint8Array<ArrayBuffer> | null = decodeMiniAppBase64Bytes(
    runtimePublicKeyBase64
  );
  if (decodedPublicKey?.byteLength !== MINI_APP_ED25519_PUBLIC_KEY_BYTES) {
    logger.error("Cannot materialize Mini App bundle without a valid Ed25519 signing public key.");
    return null;
  }

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
    let totalPublicKeyReplacements: number = 0;
    for (const assetPath of assetPaths) {
      const assetRes: Response = await fetch(new URL(assetPath, tempServer.url));
      if (!assetRes.ok) return null;
      let content: Uint8Array = await assetRes.bytes();
      const rawContentType: string = assetRes.headers.get("content-type")?.trim() ?? "";
      const contentType: string =
        rawContentType.length > 0 ? rawContentType : "application/octet-stream";
      let etag: string = assetRes.headers.get("etag")?.trim() ?? "";
      if (isJavaScriptBundleAsset(assetPath, contentType)) {
        const sourceText: string = STRICT_UTF8_DECODER.decode(content);
        if (sourceText.includes(MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER)) {
          const segments: readonly string[] = sourceText.split(
            MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER
          );
          totalPublicKeyReplacements += segments.length - 1;
          const patchedText: string = segments.join(runtimePublicKeyBase64);
          if (patchedText.includes(MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER)) {
            logger.error(
              "Bundled Mini App JS asset retained Ed25519 public key placeholder.",
              { assetPath }
            );
            return null;
          }
          content = UTF8_ENCODER.encode(patchedText);
          etag = "";
        }
      }
      if (etag.length === 0) {
        etag = `"${Bun.SHA256.hash(content, "hex")}"`;
      }
      assets.set(assetPath, {
        content,
        contentType,
        etag,
      });
    }
    if (totalPublicKeyReplacements < 1) {
      logger.error(
        "Bundled Mini App JS assets did not contain the Ed25519 signing public key placeholder."
      );
      return null;
    }
    const materialized: Readonly<BundledMiniAppAssets> = {
      html,
      assets,
    };
    if (miniAppRuntimeSigningKeyHolder.current !== expectedSigningKeyPromise) {
      return null;
    }
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
  // head 停在 "<body" 末尾，tail 从 ">" 起，响应时直接在中间拼接 data-* 属性。
  const splitOffset: number = bodyIndex + MINI_APP_REJECT_HTML_BODY_TAG.length - 1;
  return {
    head: rawHtml.slice(0, splitOffset),
    tail: rawHtml.slice(splitOffset),
  };
}

/**
 * 返回独立未授权拒绝页 `reject.html`：首次非 `HEAD` 访问时从磁盘读取并按唯一 `<body>` 预切分缓存，
 * 将本次访问拒绝诊断转义为 `<body data-*>` 属性拼接输出（不改动内联 `<script>`），附带 `200 OK` 防缓存头。
 * 外部浏览器、跨站请求及非超级管理员访问入口时只返回此页，不加载完整前端包，也不暴露业务数据。
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
