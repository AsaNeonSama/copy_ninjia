import {
  handleChatsApiRoute,
  handleGetChatDetailById,
  handleGetChatMessagesById,
  handleGetChatsRoute,
  handlePostChatFeatureById,
} from "./http/chatRoutes";
import {
  authenticateMiniAppRequest,
  buildNoStoreHeaders,
  handleGetAuthPrecheckRoute,
  handlePostAuthLoginRoute,
  htmlResponse,
  jsonResponse,
  normalizeRoutePathname,
} from "./http/common";
import {
  handleGalleryApiRoute,
  handleGetGalleryFileByName,
  handleGetGalleryRoute,
  handlePostGalleryUploadRoute,
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
import { buildMiniAppStatusView } from "./statusView";
import indexHtml from "./ui/index.html";

/**
 * 处理 `GET /api/status`：返回实时运行状态快照。
 * @param request HTTP 请求。
 * @returns JSON 响应。
 */
function handleGetStatusRoute(request: Request): Response {
  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;
  return jsonResponse(buildMiniAppStatusView());
}

/**
 * 构建传给 `Bun.serve({ routes })` 的原生路由表（含 `index.html` React HTMLBundle 与 `/api/*` 路由）。
 * @returns `Bun.serve` 原生路由定义对象。
 */
export function createMiniAppBunRoutes(): Bun.Serve.Routes<undefined, string> {
  return {
    "/healthz": {
      GET: (): Response => jsonResponse({ ok: true }),
      HEAD: (): Response =>
        new Response(null, { status: 200, headers: buildNoStoreHeaders() }),
    },
    "/": indexHtml,
    "/index.html": indexHtml,
    "/api/auth/precheck": {
      GET: (req: Request): Response => handleGetAuthPrecheckRoute(req),
    },
    "/api/auth/login": {
      POST: (req: Request): Promise<Response> => handlePostAuthLoginRoute(req),
    },
    "/api/status": {
      GET: (req: Request): Response => handleGetStatusRoute(req),
    },
    "/api/chats": {
      GET: (req: Request): Response => handleGetChatsRoute(req),
    },
    "/api/chats/:chatId": {
      GET: (req: Request): Response =>
        handleGetChatDetailById(
          req,
          (req as Bun.BunRequest<"/api/chats/:chatId">).params.chatId
        ),
    },
    "/api/chats/:chatId/messages": {
      GET: (req: Request): Response =>
        handleGetChatMessagesById(
          req,
          (req as Bun.BunRequest<"/api/chats/:chatId/messages">).params.chatId
        ),
    },
    "/api/chats/:chatId/feature": {
      POST: (req: Request): Promise<Response> =>
        handlePostChatFeatureById(
          req,
          (req as Bun.BunRequest<"/api/chats/:chatId/feature">).params.chatId
        ),
    },
    "/api/identities/whitelist": {
      GET: (req: Request): Promise<Response> => handleGetWhitelistRoute(req),
      POST: (req: Request): Promise<Response> => handlePostWhitelistRoute(req),
    },
    "/api/identities/blocklist": {
      GET: (req: Request): Promise<Response> => handleGetBlocklistRoute(req),
      POST: (req: Request): Promise<Response> => handlePostBlocklistRoute(req),
    },
    "/api/identities/permission": {
      POST: (req: Request): Promise<Response> => handlePostPermissionRoute(req),
    },
    "/api/picker/prepare": {
      POST: (req: Request): Promise<Response> => handlePostPickerPrepareRoute(req),
    },
    "/api/picker/result": {
      GET: (req: Request): Response => handleGetPickerResultRoute(req),
    },
    "/api/gallery": {
      GET: (req: Request): Promise<Response> => handleGetGalleryRoute(req),
    },
    "/api/gallery/upload": {
      POST: (req: Request): Promise<Response> => handlePostGalleryUploadRoute(req),
    },
    "/api/gallery/file/:fileName": {
      GET: (req: Request): Promise<Response> =>
        handleGetGalleryFileByName(
          req,
          (req as Bun.BunRequest<"/api/gallery/file/:fileName">).params.fileName
        ),
      HEAD: (req: Request): Promise<Response> =>
        handleGetGalleryFileByName(
          req,
          (req as Bun.BunRequest<"/api/gallery/file/:fileName">).params.fileName
        ),
    },
  };
}

/**
 * 处理到达 Mini App 本地 HTTP 源站的请求（作为 `Bun.serve` 的 `fetch` 兜底处理器，支持 Cloudflare Tunnel 子路径挂载及直接调用）。
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

  if ((method === "GET" || method === "HEAD") && routePath === "/healthz") {
    return method === "HEAD"
      ? new Response(null, { status: 200, headers: buildNoStoreHeaders() })
      : jsonResponse({ ok: true });
  }

  if ((method === "GET" || method === "HEAD") && (routePath === "/" || routePath === "/index.html")) {
    const htmlText: string = await Bun.file(indexHtml.index).text();
    return htmlResponse(htmlText, method === "HEAD");
  }

  if (!routePath.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  if (method === "GET" && routePath === "/api/auth/precheck") {
    return handleGetAuthPrecheckRoute(request);
  }
  if (method === "POST" && routePath === "/api/auth/login") {
    return handlePostAuthLoginRoute(request);
  }

  const galleryResponse: Response | null = await handleGalleryApiRoute(
    method,
    routePath,
    request
  );
  if (galleryResponse !== null) return galleryResponse;

  const rejected: Response | null = authenticateMiniAppRequest(request);
  if (rejected !== null) return rejected;

  if (method === "GET" && routePath === "/api/status") {
    return jsonResponse(buildMiniAppStatusView());
  }

  const chatsResponse: Response | null = await handleChatsApiRoute(
    method,
    routePath,
    request
  );
  if (chatsResponse !== null) return chatsResponse;

  const identitiesResponse: Response | null =
    await handleIdentitiesAndPickerApiRoute(method, routePath, request);
  if (identitiesResponse !== null) return identitiesResponse;

  return jsonResponse({ error: "API route not found" }, 404);
}
