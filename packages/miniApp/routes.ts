import { miniAppServerHolder } from "../cache/main/miniApp";
import type { MiniAppMiddleware, MiniAppRouteContext } from "../types/miniApp";
import {
  handleChatsApiRoute,
  handleGetChatDetailById,
  handleGetChatMessagesById,
  handleGetChatsRoute,
  handlePostChatFeatureById,
} from "./http/chatRoutes";
import {
  buildNoStoreHeaders,
  handleGetAuthPrecheckRoute,
  handlePostAuthLoginRoute,
  htmlResponse,
  jsonResponse,
  normalizeRoutePathname,
} from "./http/common";
import {
  handleDeleteGalleryFileByName,
  handleGalleryApiRoute,
  handleGetGalleryFileByName,
  handleGetGalleryRoute,
  handleGetSvgResourceByName,
  handlePostGalleryDeleteRoute,
  handlePostGalleryUploadRoute,
  handleProtectedAssetRoute,
} from "./http/galleryRoutes";
import {
  handleGetBlocklistRoute,
  handleGetPickerResultRoute,
  handleGetWhitelistRoute,
  handleIdentitiesAndPickerApiRoute,
  handlePostBlocklistRoute,
  handlePostPermissionRoute,
  handlePostPickerPrepareRoute,
  handlePostWhitelistRoute,
} from "./http/identityRoutes";
import {
  executeMiniAppMiddlewareChain,
  getMiniAppApiAuthMiddlewareChain,
  getMiniAppInitDataMiddlewareChain,
  getMiniAppProtectedAssetMiddlewareChain,
  getMiniAppPublicMiddlewareChain,
  isProtectedMiniAppAssetPath,
  withMiniAppMiddlewareChain,
} from "./http/middleware";
import { buildMiniAppStatusView } from "./statusView";
import indexHtml from "./ui/index.html";

/**
 * 处理 `GET /api/status`：返回实时运行状态快照。
 * @returns JSON 响应。
 */
function handleGetStatusRoute(): Response {
  return jsonResponse(buildMiniAppStatusView());
}

/**
 * 读取 Mini App 入口 HTML 文本（当 `Bun.serve` 已启动时从内部 `/_bundle` 路由获取注入了打包产物路径的 HTML；直接单元测试调用时读取源文件），并附带完整的 CSP 与 `X-Frame-Options` 响应头返回。
 * @param headOnly 是否为 `HEAD` 请求。
 * @returns 带完整安全响应头的 HTML `Response`。
 */
async function serveMiniAppIndexHtml(headOnly: boolean): Promise<Response> {
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
 * 构建传给 `Bun.serve({ routes })` 的原生路由表（所有业务 API 与 SVG/图库资源路由均统一由前置中间件链包装）。
 * @returns `Bun.serve` 原生路由定义对象。
 */
export function createMiniAppBunRoutes(): Bun.Serve.Routes<undefined, string> {
  const publicChain: readonly MiniAppMiddleware[] =
    getMiniAppPublicMiddlewareChain();
  const initDataChain: readonly MiniAppMiddleware[] =
    getMiniAppInitDataMiddlewareChain();
  const protectedAssetChain: readonly MiniAppMiddleware[] =
    getMiniAppProtectedAssetMiddlewareChain();
  const apiAuthChain: readonly MiniAppMiddleware[] =
    getMiniAppApiAuthMiddlewareChain();

  return {
    "/healthz": {
      GET: withMiniAppMiddlewareChain(
        publicChain,
        (): Response => jsonResponse({ ok: true })
      ),
      HEAD: withMiniAppMiddlewareChain(
        publicChain,
        (): Response =>
          new Response(null, { status: 200, headers: buildNoStoreHeaders() })
      ),
    },
    "/_bundle": indexHtml,
    "/": {
      GET: withMiniAppMiddlewareChain(
        publicChain,
        (): Promise<Response> => serveMiniAppIndexHtml(false)
      ),
      HEAD: withMiniAppMiddlewareChain(
        publicChain,
        (): Promise<Response> => serveMiniAppIndexHtml(true)
      ),
    },
    "/index.html": {
      GET: withMiniAppMiddlewareChain(
        publicChain,
        (): Promise<Response> => serveMiniAppIndexHtml(false)
      ),
      HEAD: withMiniAppMiddlewareChain(
        publicChain,
        (): Promise<Response> => serveMiniAppIndexHtml(true)
      ),
    },
    "/api/auth/precheck": {
      GET: withMiniAppMiddlewareChain(
        initDataChain,
        (): Response => handleGetAuthPrecheckRoute()
      ),
    },
    "/api/auth/login": {
      POST: withMiniAppMiddlewareChain(
        initDataChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostAuthLoginRoute(ctx.request)
      ),
    },
    "/api/status": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (): Response => handleGetStatusRoute()
      ),
    },
    "/api/chats": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (): Response => handleGetChatsRoute()
      ),
    },
    "/api/chats/:chatId": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatDetailById(ctx.params.chatId ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          chatId: (req as Bun.BunRequest<"/api/chats/:chatId">).params.chatId,
        })
      ),
    },
    "/api/chats/:chatId/messages": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetChatMessagesById(
            ctx.request,
            ctx.params.chatId ?? "",
            ctx.url
          ),
        (req: Request): Readonly<Record<string, string>> => ({
          chatId: (req as Bun.BunRequest<"/api/chats/:chatId/messages">).params.chatId,
        })
      ),
    },
    "/api/chats/:chatId/feature": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostChatFeatureById(ctx.request, ctx.params.chatId ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          chatId: (req as Bun.BunRequest<"/api/chats/:chatId/feature">).params.chatId,
        })
      ),
    },
    "/api/identities/whitelist": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetWhitelistRoute(ctx.request, ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostWhitelistRoute(ctx.request)
      ),
    },
    "/api/identities/blocklist": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetBlocklistRoute(ctx.request, ctx.url)
      ),
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostBlocklistRoute(ctx.request)
      ),
    },
    "/api/identities/permission": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostPermissionRoute(ctx.request)
      ),
    },
    "/api/picker/prepare": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostPickerPrepareRoute(ctx.request)
      ),
    },
    "/api/picker/result": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Response =>
          handleGetPickerResultRoute(ctx.request, ctx.url)
      ),
    },
    "/api/gallery": {
      GET: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetGalleryRoute(ctx.request)
      ),
    },
    "/api/gallery/upload": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostGalleryUploadRoute(ctx.request)
      ),
    },
    "/api/gallery/delete": {
      POST: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handlePostGalleryDeleteRoute(ctx.request)
      ),
    },
    "/api/gallery/file/:fileName": {
      GET: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetGalleryFileByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/api/gallery/file/:fileName">).params.fileName,
        })
      ),
      HEAD: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetGalleryFileByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/api/gallery/file/:fileName">).params.fileName,
        })
      ),
      DELETE: withMiniAppMiddlewareChain(
        apiAuthChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleDeleteGalleryFileByName(ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/api/gallery/file/:fileName">).params.fileName,
        })
      ),
    },
    "/api/resources/svg/:fileName": {
      GET: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetSvgResourceByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/api/resources/svg/:fileName">).params.fileName,
        })
      ),
      HEAD: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetSvgResourceByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/api/resources/svg/:fileName">).params.fileName,
        })
      ),
    },
    "/miniAppResoures/:fileName": {
      GET: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetSvgResourceByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/miniAppResoures/:fileName">).params.fileName,
        })
      ),
      HEAD: withMiniAppMiddlewareChain(
        protectedAssetChain,
        (ctx: Readonly<MiniAppRouteContext>): Promise<Response> =>
          handleGetSvgResourceByName(ctx.request, ctx.params.fileName ?? ""),
        (req: Request): Readonly<Record<string, string>> => ({
          fileName: (req as Bun.BunRequest<"/miniAppResoures/:fileName">).params.fileName,
        })
      ),
    },
  };
}

/**
 * 处理到达 Mini App 本地 HTTP 源站的请求（统一通过前置中间件链完成跨站拦截、浏览器直接导航拦截、Telegram WebApp 超管签名校验与会话校验）。
 * @param request 传入的 HTTP `Request`。
 * @returns 完整的 HTTP `Response`。
 */
export async function handleMiniAppHttpRequest(request: Request): Promise<Response> {
  const url: URL = new URL(request.url);
  const method: string = request.method.toUpperCase();
  const normalized: { readonly redirectTo?: string; readonly routePath: string } =
    normalizeRoutePathname(url.pathname);

  if (normalized.redirectTo !== undefined && (method === "GET" || method === "HEAD")) {
    const headers: Record<string, string> = buildNoStoreHeaders();
    headers.Location = `${normalized.redirectTo}${url.search}`;
    return new Response(null, {
      status: 308,
      headers,
    });
  }

  const routePath: string = normalized.routePath;
  const ctx: Readonly<MiniAppRouteContext> = {
    request,
    url,
    method,
    routePath,
    params: {},
  };

  if ((method === "GET" || method === "HEAD") && routePath === "/healthz") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppPublicMiddlewareChain(),
      (): Response =>
        method === "HEAD"
          ? new Response(null, { status: 200, headers: buildNoStoreHeaders() })
          : jsonResponse({ ok: true })
    );
  }

  if (
    (method === "GET" || method === "HEAD") &&
    (routePath === "/" || routePath === "/index.html")
  ) {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppPublicMiddlewareChain(),
      (): Promise<Response> => serveMiniAppIndexHtml(method === "HEAD")
    );
  }

  if (method === "GET" && routePath === "/api/auth/precheck") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppInitDataMiddlewareChain(),
      (): Response => handleGetAuthPrecheckRoute()
    );
  }

  if (method === "POST" && routePath === "/api/auth/login") {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppInitDataMiddlewareChain(),
      (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> =>
        handlePostAuthLoginRoute(routeCtx.request)
    );
  }

  if (method !== "DELETE" && isProtectedMiniAppAssetPath(routePath)) {
    return executeMiniAppMiddlewareChain(
      ctx,
      getMiniAppProtectedAssetMiddlewareChain(),
      async (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> => {
        const assetResponse: Response | null = await handleProtectedAssetRoute(
          routeCtx.method,
          routeCtx.routePath,
          routeCtx.request
        );
        if (assetResponse !== null) return assetResponse;
        return jsonResponse({ error: "Resource not found" }, 404);
      }
    );
  }

  if (!routePath.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return executeMiniAppMiddlewareChain(
    ctx,
    getMiniAppApiAuthMiddlewareChain(),
    async (routeCtx: Readonly<MiniAppRouteContext>): Promise<Response> => {
      if (routeCtx.method === "GET" && routeCtx.routePath === "/api/status") {
        return handleGetStatusRoute();
      }
      const galleryResponse: Response | null = await handleGalleryApiRoute(
        routeCtx.method,
        routeCtx.routePath,
        routeCtx.request
      );
      if (galleryResponse !== null) return galleryResponse;

      const chatsResponse: Response | null = await handleChatsApiRoute(
        routeCtx.method,
        routeCtx.routePath,
        routeCtx.request
      );
      if (chatsResponse !== null) return chatsResponse;

      const identitiesResponse: Response | null =
        await handleIdentitiesAndPickerApiRoute(
          routeCtx.method,
          routeCtx.routePath,
          routeCtx.request
        );
      if (identitiesResponse !== null) return identitiesResponse;

      return jsonResponse({ error: "API route not found" }, 404);
    }
  );
}
