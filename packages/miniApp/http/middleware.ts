import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN,
  MINI_APP_GALLERY_FILE_ROUTE_PATTERN,
  MINI_APP_PROTECTED_ASSET_EXT_PATTERN,
  MINI_APP_SHA256_HEX_PATTERN,
  MINI_APP_SVG_RESOURCE_ROUTE_PATTERN,
} from "../../consts/miniApp";
import {
  verifyMiniAppAssetToken,
  verifyMiniAppInitData,
} from "../../libs/miniAppAuth";
import type {
  MiniAppAuthResult,
  MiniAppAuthSession,
  MiniAppMiddleware,
  MiniAppRouteContext,
  MiniAppRouteHandler,
} from "../../types/miniApp";
import { miniAppAuthSessions } from "../../cache/main/miniApp";
import {
  accessErrorResponse,
  checkSuperAdminPasswordLockout,
  extractAssetTokenFromQuery,
  extractInitDataFromHeaders,
  extractSessionToken,
  normalizeRoutePathname,
  purgeExpiredAuthSessions,
} from "./common";

/**
 * 校验请求携带的 Telegram WebApp `initData` 签名（或受保护静态/图库资源稳定令牌 `token`）、时效、超级管理员身份与 30 分钟密码锁定状态（第一层网关校验）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `token` 或 `initData`。
 * @returns 验证通过时返回 `null`，失败时返回带真实请求诊断的 `401` 或 `403` `Response`。
 */
export function authenticateMiniAppInitData(
  request: Request,
  allowQueryAuth: boolean = false
): Response | null {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return accessErrorResponse(request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "Cross-site request to Telegram Mini App endpoint is forbidden.",
    });
  }
  if (allowQueryAuth) {
    const assetToken: string = extractAssetTokenFromQuery(request);
    if (
      assetToken.length > 0 &&
      verifyMiniAppAssetToken(assetToken, BOT_TOKEN, SUPER_ADMIN_USER_ID)
    ) {
      return checkSuperAdminPasswordLockout(request);
    }
  }
  const initData: string = extractInitDataFromHeaders(request, allowQueryAuth);
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
  });
  if (authResult.ok) {
    return checkSuperAdminPasswordLockout(request);
  }
  const status: number = authResult.reason === "forbidden_user" ? 403 : 401;
  return accessErrorResponse(request, {
    status,
    code: authResult.reason.toUpperCase(),
    reason: authResult.reason,
    error:
      authResult.reason === "forbidden_user"
        ? "Only the configured SuperAdmin user ID is permitted to access this Mini App."
        : `Telegram WebApp initData verification failed (${authResult.reason}). Direct external browser access is denied.`,
  });
}

/**
 * 校验请求的 `initData` 签名与 90 分钟有效期的访问密码认证会话（双层完整鉴权）。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取凭据。
 * @returns 验证通过时返回 `null`，失败时返回对应的 `401` 或 `403` JSON `Response`。
 */
export function authenticateMiniAppRequest(
  request: Request,
  allowQueryAuth: boolean = false
): Response | null {
  const initRejected: Response | null = authenticateMiniAppInitData(
    request,
    allowQueryAuth
  );
  if (initRejected !== null) return initRejected;
  return verifyMiniAppSessionToken(request, allowQueryAuth);
}

/**
 * 校验请求携带的 90 分钟有效期访问密码认证会话令牌。
 * @param request HTTP 请求对象。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `session`。
 * @returns 验证通过时返回 `null`，缺失或过期时返回 `401` JSON `Response`。
 */
function verifyMiniAppSessionToken(
  request: Request,
  allowQueryAuth: boolean = false
): Response | null {
  const nowMs: number = Date.now();
  purgeExpiredAuthSessions(nowMs);
  const sessionToken: string = extractSessionToken(request, allowQueryAuth);
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "Mini App 访问密码尚未验证，请先输入访问密码解锁控制台。",
    });
  }
  const session: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(sessionToken);
  if (session === undefined || session.expiresAt <= nowMs) {
    return accessErrorResponse(request, {
      status: 401,
      code: "PASSWORD_REQUIRED",
      reason: "password_required",
      error: "Mini App 访问认证已满 90 分钟过期或无效，请重新输入访问密码。",
    });
  }
  return null;
}

/**
 * 拦截跨站请求（`Sec-Fetch-Site: cross-site`）的通用安全边界中间件。
 * @param ctx 路由请求上下文。
 * @param next 调用下一环中间件的回调。
 * @returns HTTP 响应。
 */
export function miniAppCrossSiteGuardMiddleware(
  ctx: Readonly<MiniAppRouteContext>,
  next: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (ctx.request.headers.get("sec-fetch-site") === "cross-site") {
    return accessErrorResponse(ctx.request, {
      status: 403,
      code: "CROSS_SITE_FORBIDDEN",
      reason: "forbidden_user",
      error: "Cross-site request to Telegram Mini App endpoint is forbidden.",
    });
  }
  return next();
}

/**
 * 拦截从浏览器地址栏直接导航访问受保护图片或 SVG 资源（`Sec-Fetch-Dest: document` 或 `Sec-Fetch-Mode: navigate`）的边界中间件。
 * @param ctx 路由请求上下文。
 * @param next 调用下一环中间件的回调。
 * @returns HTTP 响应。
 */
export function miniAppAssetNavigationGuardMiddleware(
  ctx: Readonly<MiniAppRouteContext>,
  next: () => Response | Promise<Response>
): Response | Promise<Response> {
  if (
    ctx.request.headers.get("sec-fetch-dest") === "document" ||
    ctx.request.headers.get("sec-fetch-mode") === "navigate"
  ) {
    return accessErrorResponse(ctx.request, {
      status: 403,
      code: "DIRECT_NAVIGATION_FORBIDDEN",
      reason: "forbidden_user",
      error: "禁止从浏览器地址栏直接导航访问受保护的图片或 SVG 资源。",
    });
  }
  return next();
}

/**
 * 创建校验 Telegram WebApp `initData` HMAC-SHA256 签名、时效、`SUPER_ADMIN_USER_ID` 超管身份及 30 分钟密码锁定状态的中间件。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `initData` 查询参数提取凭据（供受保护图片与 SVG 资源加载）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppInitDataMiddleware(
  allowQueryAuth: boolean = false
): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> => {
    const rejected: Response | null = authenticateMiniAppInitData(
      ctx.request,
      allowQueryAuth
    );
    if (rejected !== null) return rejected;
    return next();
  };
}

/**
 * 创建校验 90 分钟密码认证会话令牌（`X-Mini-App-Session`）的中间件。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `session` 查询参数提取凭据。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppSessionMiddleware(
  allowQueryAuth: boolean = false
): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> => {
    const rejected: Response | null = verifyMiniAppSessionToken(
      ctx.request,
      allowQueryAuth
    );
    if (rejected !== null) return rejected;
    return next();
  };
}

/** 仅校验跨站防护、Telegram WebApp 签名、超管 ID 与 30 分钟密码锁定的中间件链（用于 `/api/auth/precheck` 与 `/api/auth/login`）。 */
const initDataMiddlewareChain: readonly MiniAppMiddleware[] = [
  miniAppCrossSiteGuardMiddleware,
  createMiniAppInitDataMiddleware(false),
];

/** 受保护 SVG 与图库图片资源的专属鉴权中间件链（防跨站 + 禁浏览器直接导航 + 强制校验 Telegram WebApp 签名与超管 ID）。 */
const protectedAssetMiddlewareChain: readonly MiniAppMiddleware[] = [
  miniAppCrossSiteGuardMiddleware,
  miniAppAssetNavigationGuardMiddleware,
  createMiniAppInitDataMiddleware(true),
];

/** 业务 JSON 与写操作 API 的完整双层鉴权中间件链（防跨站 + Telegram WebApp 超管签名 + 90 分钟密码会话）。 */
const apiAuthMiddlewareChain: readonly MiniAppMiddleware[] = [
  miniAppCrossSiteGuardMiddleware,
  createMiniAppInitDataMiddleware(false),
  createMiniAppSessionMiddleware(false),
];

/** 图库原图附件下载路由的完整双层鉴权中间件链（防跨站 + Telegram WebApp 超管签名或资源令牌 + 90 分钟密码会话，允许 GET/HEAD 查询参数传凭据以供 Telegram 原生下载器直连保存至系统默认下载目录）。 */
const galleryDownloadMiddlewareChain: readonly MiniAppMiddleware[] = [
  miniAppCrossSiteGuardMiddleware,
  createMiniAppInitDataMiddleware(true),
  createMiniAppSessionMiddleware(true),
];

/**
 * 获取公开路由（`/healthz`、`/`、`/index.html`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppPublicMiddlewareChain(): readonly MiniAppMiddleware[] {
  return [];
}

/**
 * 获取首屏预检与密码登录路由（`/api/auth/precheck`、`/api/auth/login`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppInitDataMiddlewareChain(): readonly MiniAppMiddleware[] {
  return initDataMiddlewareChain;
}

/**
 * 获取受保护图片与 SVG 资源路由（`/api/gallery/file/:fileName`、`/api/resources/svg/:fileName`、`/miniAppResoures/:fileName`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppProtectedAssetMiddlewareChain(): readonly MiniAppMiddleware[] {
  return protectedAssetMiddlewareChain;
}

/**
 * 获取受保护业务 API 路由（`/api/status`、`/api/chats/*`、`/api/identities/*`、`/api/picker/*`、`/api/gallery*`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppApiAuthMiddlewareChain(): readonly MiniAppMiddleware[] {
  return apiAuthMiddlewareChain;
}

/**
 * 获取图库原图附件下载路由（`/api/gallery/download/:fileName`）的完整双层鉴权中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppGalleryDownloadMiddlewareChain(): readonly MiniAppMiddleware[] {
  return galleryDownloadMiddlewareChain;
}

/**
 * 判断归一化后的内部路由路径是否属于受保护的图片或 SVG 静态/动态资源路径（排除走完整双层 API 鉴权的 `/api/gallery/download/:fileName`）。
 * @param routePath 归一化后的内部路由路径。
 * @returns 命中图片或 SVG 资源路径时返回 `true`。
 */
export function isProtectedMiniAppAssetPath(routePath: string): boolean {
  if (MINI_APP_GALLERY_DOWNLOAD_ROUTE_PATTERN.test(routePath)) {
    return false;
  }
  return (
    MINI_APP_GALLERY_FILE_ROUTE_PATTERN.test(routePath) ||
    MINI_APP_SVG_RESOURCE_ROUTE_PATTERN.test(routePath) ||
    routePath.startsWith("/miniAppResoures/") ||
    routePath.startsWith("/api/resources/svg/") ||
    MINI_APP_PROTECTED_ASSET_EXT_PATTERN.test(routePath)
  );
}

/**
 * 按洋葱管道模型顺序执行中间件链并最终调用路由处理器。
 * @param ctx 路由请求上下文。
 * @param middlewares 按顺序执行的中间件列表。
 * @param handler 终端路由处理器。
 * @returns 最终生成的 HTTP `Response`。
 */
export async function executeMiniAppMiddlewareChain(
  ctx: Readonly<MiniAppRouteContext>,
  middlewares: readonly MiniAppMiddleware[],
  handler: MiniAppRouteHandler
): Promise<Response> {
  let index: number = -1;
  const dispatch = async (currentIndex: number): Promise<Response> => {
    if (currentIndex <= index) {
      throw new Error("Mini App middleware next() called multiple times.");
    }
    index = currentIndex;
    const currentMiddleware: MiniAppMiddleware | undefined =
      middlewares[currentIndex];
    if (currentMiddleware === undefined) {
      return handler(ctx);
    }
    return currentMiddleware(ctx, (): Response | Promise<Response> =>
      dispatch(currentIndex + 1)
    );
  };
  return dispatch(0);
}

/**
 * 将中间件链与路由处理器包装为可直接挂入 `Bun.serve({ routes })` 的单参请求处理函数。
 * @param middlewares 按顺序执行的中间件列表。
 * @param handler 终端路由处理器。
 * @param extractParams 可选的路径参数提取函数。
 * @returns 接受 `Request` 并返回 `Promise<Response>` 的函数。
 */
export function withMiniAppMiddlewareChain(
  middlewares: readonly MiniAppMiddleware[],
  handler: MiniAppRouteHandler,
  extractParams?: (request: Request) => Readonly<Record<string, string>>
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url: URL = new URL(request.url);
    const method: string = request.method.toUpperCase();
    const normalized: { readonly redirectTo?: string; readonly routePath: string } =
      normalizeRoutePathname(url.pathname);
    const ctx: Readonly<MiniAppRouteContext> = {
      request,
      url,
      method,
      routePath: normalized.routePath,
      params: extractParams !== undefined ? extractParams(request) : {},
    };
    return executeMiniAppMiddlewareChain(ctx, middlewares, handler);
  };
}
