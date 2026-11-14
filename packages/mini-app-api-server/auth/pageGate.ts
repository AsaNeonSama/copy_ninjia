import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS,
  MINI_APP_PAGE_GATE_COOKIE_NAME,
} from "../../consts/miniApp";
import {
  deriveMiniAppPageGateSecretKey,
  issueMiniAppPageGateToken,
  verifyMiniAppPageGateToken,
} from "../../libs/miniAppAuth";
import type { MiniAppRouteContext } from "../../types/miniApp/server";
import {
  accessErrorResponse,
} from "../libs/response";
import type {
  AccessErrorResponseParams,
  BuildMiniAppAccessDiagnosticsParams,
} from "../libs/response";
import {
  hasDisallowedSecFetchSite,
  hasDisallowedSubresourceFetchMetadata,
  isAllowedRequestOriginUrl,
} from "../middleware/headerGuard";
import {
  hasMiniAppInitDataHeader,
  verifyMiniAppHeaderInitDataError,
} from "../middleware/initData";
import {
  checkSuperAdminPasswordLockout,
  getSuperAdminPasswordLockoutRemainingMinutes,
} from "./session";

/** 模块加载时由 `BOT_TOKEN` 派生一次的单页门禁令牌 HMAC-SHA256 密钥（进程生命周期内恒定）。 */
const MINI_APP_PAGE_GATE_SECRET_KEY: Uint8Array =
  deriveMiniAppPageGateSecretKey(BOT_TOKEN);

/** 单页路由（`/`、`/index.html`）门禁判定结果。 */
export type MiniAppPageGateDecision =
  | {
    readonly allowed: true;
    readonly issueGateCookie: boolean;
  }
  | {
    readonly allowed: false;
    readonly clearGateCookie: boolean;
    readonly diagParams: Readonly<BuildMiniAppAccessDiagnosticsParams>;
  };

/**
 * 判断当前请求是否经由 HTTPS 接入（检查请求 URL 协议前缀或首跳 `X-Forwarded-Proto`）。
 * @param request HTTP 请求对象。
 * @returns 为 HTTPS 请求时返回 `true`。
 */
function isSecureMiniAppRequest(request: Request): boolean {
  if (
    request.url.startsWith("https:") ||
    request.url.slice(0, 6).toLowerCase() === "https:"
  ) {
    return true;
  }
  const forwardedProto: string | null = request.headers.get("x-forwarded-proto");
  if (forwardedProto === null) return false;
  const commaIndex: number = forwardedProto.indexOf(",");
  const firstHop: string = (
    commaIndex >= 0 ? forwardedProto.slice(0, commaIndex) : forwardedProto
  )
    .trim()
    .toLowerCase();
  return firstHop === "https";
}

/**
 * 在不产生中间数组与非命中切片分配的前提下扫描 `Cookie` 请求头，读取 `MINI_APP_PAGE_GATE_COOKIE_NAME` 的值。
 * @param request HTTP 请求对象。
 * @returns 未携带同名门禁 Cookie 时返回 `null`；携带但无值/空值时返回空字符串；否则返回去空白后的令牌值。
 */
export function readMiniAppPageGateCookie(request: Request): string | null {
  const cookieHeader: string | null = request.headers.get("cookie");
  if (cookieHeader === null || cookieHeader.length === 0) return null;
  const targetName: string = MINI_APP_PAGE_GATE_COOKIE_NAME;
  const targetLen: number = targetName.length;
  const headerLen: number = cookieHeader.length;
  let cursor: number = 0;
  while (cursor < headerLen) {
    const semiIndex: number = cookieHeader.indexOf(";", cursor);
    const pairEnd: number = semiIndex >= 0 ? semiIndex : headerLen;
    let nameStart: number = cursor;
    while (nameStart < pairEnd && cookieHeader.charCodeAt(nameStart) <= 0x20) {
      nameStart += 1;
    }
    const eqIndex: number = cookieHeader.indexOf("=", nameStart);
    const rawNameEnd: number =
      eqIndex >= 0 && eqIndex < pairEnd ? eqIndex : pairEnd;
    let nameEnd: number = rawNameEnd;
    while (nameEnd > nameStart && cookieHeader.charCodeAt(nameEnd - 1) <= 0x20) {
      nameEnd -= 1;
    }
    if (
      nameEnd - nameStart === targetLen &&
      cookieHeader.startsWith(targetName, nameStart)
    ) {
      if (eqIndex < 0 || eqIndex >= pairEnd) return "";
      return cookieHeader.slice(eqIndex + 1, pairEnd).trim();
    }
    cursor = pairEnd + 1;
  }
  return null;
}

/**
 * 判断请求 `Cookie` 头是否包含 `MINI_APP_PAGE_GATE_COOKIE_NAME` 条目（含空值）。
 * @param request HTTP 请求对象。
 * @returns 携带了同名门禁 Cookie 时返回 `true`。
 */
export function hasMiniAppPageGateCookie(request: Request): boolean {
  return readMiniAppPageGateCookie(request) !== null;
}

/**
 * 核验请求 `Cookie` 头中的单页门禁令牌是否签名有效且未过期。
 * @param request HTTP 请求对象。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 门禁 Cookie 有效时返回 `true`。
 */
export function hasValidMiniAppPageGateCookie(
  request: Request,
  nowMs: number = Date.now()
): boolean {
  const token: string | null = readMiniAppPageGateCookie(request);
  if (token === null || token.length === 0) return false;
  return verifyMiniAppPageGateToken({
    token,
    secretKey: MINI_APP_PAGE_GATE_SECRET_KEY,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    nowMs,
  });
}

/**
 * 签发最新单页门禁令牌并构造 `Set-Cookie` 响应头值。
 * @param request HTTP 请求对象（用于判定是否附加 `; Secure`）。
 * @param nowMs 签发时刻毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 完整的 `Set-Cookie` 响应头字符串。
 */
export function buildMiniAppPageGateSetCookieHeader(
  request: Request,
  nowMs: number = Date.now()
): string {
  const token: string = issueMiniAppPageGateToken({
    secretKey: MINI_APP_PAGE_GATE_SECRET_KEY,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    nowMs,
  });
  const secureFlag: string = isSecureMiniAppRequest(request) ? "; Secure" : "";
  return `${MINI_APP_PAGE_GATE_COOKIE_NAME}=${token}; Path=/; Max-Age=${MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureFlag}`;
}

/**
 * 构造立即清除单页门禁 Cookie（`Max-Age=0`）的 `Set-Cookie` 响应头值。
 * @param request HTTP 请求对象（用于判定是否附加 `; Secure`）。
 * @returns 清除门禁 Cookie 的 `Set-Cookie` 响应头字符串。
 */
function buildClearMiniAppPageGateSetCookieHeader(request: Request): string {
  const secureFlag: string = isSecureMiniAppRequest(request) ? "; Secure" : "";
  return `${MINI_APP_PAGE_GATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`;
}

/**
 * 为响应写入新签发的单页门禁 `Set-Cookie` 响应头。
 * @param response 待写入响应头的 `Response` 对象。
 * @param request HTTP 请求对象。
 * @param nowMs 签发时刻毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 同一 `Response` 对象。
 */
export function attachMiniAppPageGateCookie(
  response: Response,
  request: Request,
  nowMs: number = Date.now()
): Response {
  response.headers.set(
    "Set-Cookie",
    buildMiniAppPageGateSetCookieHeader(request, nowMs)
  );
  return response;
}

/**
 * 为响应无条件写入清除单页门禁 Cookie（`Max-Age=0`）的 `Set-Cookie` 响应头。
 * @param response 待写入响应头的 `Response` 对象。
 * @param request HTTP 请求对象。
 * @returns 同一 `Response` 对象。
 */
export function attachClearMiniAppPageGateCookie(
  response: Response,
  request: Request
): Response {
  response.headers.set(
    "Set-Cookie",
    buildClearMiniAppPageGateSetCookieHeader(request)
  );
  return response;
}

/**
 * 当请求携带了单页门禁 Cookie 时，为拒绝响应附加清除该 Cookie 的 `Set-Cookie` 响应头。
 * @param response 待处理的拒绝 `Response` 对象。
 * @param request HTTP 请求对象。
 * @returns 同一 `Response` 对象。
 */
export function clearMiniAppPageGateCookieIfPresent(
  response: Response,
  request: Request
): Response {
  if (hasMiniAppPageGateCookie(request)) {
    attachClearMiniAppPageGateCookie(response, request);
  }
  return response;
}

/**
 * 评估单页文档路由（`/`、`/index.html`）的门禁准入状态：先拦截跨站请求，再优先核验显式 `initData` 请求头，最后核验单页门禁 Cookie 与密码锁定状态。
 * @param request HTTP 请求对象。
 * @returns 准入决策与拒绝诊断参数。
 */
export function evaluateMiniAppPageGateRequest(
  request: Request
): MiniAppPageGateDecision {
  const headers: Headers = request.headers;
  const originHeader: string | null = headers.get("origin");
  if (
    hasDisallowedSecFetchSite(headers) ||
    (originHeader !== null &&
      originHeader.trim().length > 0 &&
      !isAllowedRequestOriginUrl(originHeader, request))
  ) {
    return {
      allowed: false,
      clearGateCookie: hasMiniAppPageGateCookie(request),
      diagParams: {
        status: 403,
        code: "CROSS_SITE_FORBIDDEN",
        error: "CROSS_SITE_FORBIDDEN",
      },
    };
  }

  if (hasMiniAppInitDataHeader(headers)) {
    const errorParams: Readonly<AccessErrorResponseParams> | null =
      verifyMiniAppHeaderInitDataError(request);
    if (errorParams !== null) {
      return {
        allowed: false,
        clearGateCookie: hasMiniAppPageGateCookie(request),
        diagParams: errorParams,
      };
    }
    return { allowed: true, issueGateCookie: true };
  }

  const gateCookie: string | null = readMiniAppPageGateCookie(request);
  const nowMs: number = Date.now();
  if (
    gateCookie !== null &&
    gateCookie.length > 0 &&
    verifyMiniAppPageGateToken({
      token: gateCookie,
      secretKey: MINI_APP_PAGE_GATE_SECRET_KEY,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      nowMs,
    })
  ) {
    const remainingMinutes: number | null =
      getSuperAdminPasswordLockoutRemainingMinutes(nowMs);
    if (remainingMinutes === null) {
      return { allowed: true, issueGateCookie: false };
    }
    return {
      allowed: false,
      clearGateCookie: true,
      diagParams: {
        status: 403,
        code: "PASSWORD_LOCKED",
        error: "PASSWORD_LOCKED",
        remainingMinutes,
      },
    };
  }

  return {
    allowed: false,
    clearGateCookie: gateCookie !== null,
    diagParams: {
      status: 401,
      code: "MISSING_INIT_DATA",
      error: "MISSING_INIT_DATA",
    },
  };
}

/**
 * 校验前端打包静态资源（`/chunk-*` 等）请求的跨站/直接导航防护与门禁凭据；未授权时返回 `401`/`403` JSON 诊断响应。
 * @param ctx 路由请求上下文。
 * @returns 校验通过时返回 `null`，未通过时返回拦截 `Response`。
 */
export function authorizeMiniAppBundleAssetRequest(
  ctx: Readonly<MiniAppRouteContext>
): Response | null {
  const request: Request = ctx.request;
  const headers: Headers = request.headers;

  if (hasDisallowedSecFetchSite(headers)) {
    return clearMiniAppPageGateCookieIfPresent(
      accessErrorResponse(request, {
        status: 403,
        code: "CROSS_SITE_FORBIDDEN",
        reason: "forbidden_user",
        error: "CROSS_SITE_FORBIDDEN",
      }),
      request
    );
  }
  if (hasDisallowedSubresourceFetchMetadata(headers)) {
    return accessErrorResponse(request, {
      status: 403,
      code: "DIRECT_NAVIGATION_FORBIDDEN",
      reason: "forbidden_user",
      error: "DIRECT_NAVIGATION_FORBIDDEN",
    });
  }
  const originHeader: string | null = headers.get("origin");
  if (
    originHeader !== null &&
    originHeader.trim().length > 0 &&
    !isAllowedRequestOriginUrl(originHeader, request, ctx.url)
  ) {
    return clearMiniAppPageGateCookieIfPresent(
      accessErrorResponse(request, {
        status: 403,
        code: "CROSS_SITE_FORBIDDEN",
        reason: "forbidden_user",
        error: "CROSS_SITE_FORBIDDEN",
      }),
      request
    );
  }
  const refererHeader: string | null = headers.get("referer");
  if (
    refererHeader !== null &&
    refererHeader.trim().length > 0 &&
    !isAllowedRequestOriginUrl(refererHeader, request, ctx.url)
  ) {
    return clearMiniAppPageGateCookieIfPresent(
      accessErrorResponse(request, {
        status: 403,
        code: "CROSS_SITE_FORBIDDEN",
        reason: "forbidden_user",
        error: "CROSS_SITE_FORBIDDEN",
      }),
      request
    );
  }

  if (hasMiniAppInitDataHeader(headers)) {
    const errorParams: Readonly<AccessErrorResponseParams> | null =
      verifyMiniAppHeaderInitDataError(request);
    if (errorParams !== null) {
      return clearMiniAppPageGateCookieIfPresent(
        accessErrorResponse(request, errorParams),
        request
      );
    }
    return null;
  }

  const gateCookie: string | null = readMiniAppPageGateCookie(request);
  const nowMs: number = Date.now();
  if (
    gateCookie !== null &&
    gateCookie.length > 0 &&
    verifyMiniAppPageGateToken({
      token: gateCookie,
      secretKey: MINI_APP_PAGE_GATE_SECRET_KEY,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      nowMs,
    })
  ) {
    const lockoutRes: Response | null = checkSuperAdminPasswordLockout(
      request,
      nowMs
    );
    if (lockoutRes !== null) {
      return attachClearMiniAppPageGateCookie(lockoutRes, request);
    }
    return null;
  }

  const missingRes: Response = accessErrorResponse(request, {
    status: 401,
    code: "MISSING_INIT_DATA",
    reason: "missing_init_data",
    error: "MISSING_INIT_DATA",
  });
  return gateCookie !== null
    ? attachClearMiniAppPageGateCookie(missingRes, request)
    : missingRes;
}
