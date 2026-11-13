import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_INIT_DATA_HEADER,
} from "../../consts/miniApp";
import {
  deriveMiniAppAssetTokenDigest,
  deriveMiniAppInitDataSecretKey,
  verifyMiniAppAssetToken,
  verifyMiniAppInitData,
} from "../../libs/miniAppAuth";
import type { MiniAppAuthResult } from "../../types/miniApp/auth";
import type {
  MiniAppMiddleware,
  MiniAppRouteContext,
} from "../../types/miniApp/server";
import {
  checkSuperAdminPasswordLockout,
  getSuperAdminPasswordLockoutRemainingMinutes,
  hasActiveMiniAppAuthSession,
} from "../auth/session";
import {
  extractAssetTokenFromQuery,
  extractInitDataFromHeaders,
  extractSessionToken,
} from "../libs/request";
import { accessErrorResponse } from "../libs/response";
import type { AccessErrorResponseParams } from "../libs/response";
import { extractVerifiedMiniAppHeaderInitData } from "./headerGuard";

/** 模块加载时由 `BOT_TOKEN` 派生一次的 `initData` HMAC-SHA256 验签密钥（进程生命周期内恒定）。 */
const MINI_APP_INIT_DATA_SECRET_KEY: Uint8Array =
  deriveMiniAppInitDataSecretKey(BOT_TOKEN);

/** 模块加载时由 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 派生一次的受保护资源令牌 32 字节摘要（进程生命周期内恒定）。 */
const MINI_APP_ASSET_TOKEN_DIGEST: Uint8Array = deriveMiniAppAssetTokenDigest(
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID
);

/**
 * 判断请求是否显式携带了非空的 `X-Telegram-Init-Data` 或 `Authorization` 凭据请求头。
 * @param headers HTTP 请求头对象。
 * @returns 任一凭据请求头存在且去空白后非空时返回 `true`。
 */
export function hasMiniAppInitDataHeader(headers: Headers): boolean {
  const rawInitHeader: string | null = headers.get(MINI_APP_INIT_DATA_HEADER);
  if (rawInitHeader !== null && rawInitHeader.trim().length > 0) return true;
  const rawAuthHeader: string | null = headers.get("authorization");
  return rawAuthHeader !== null && rawAuthHeader.trim().length > 0;
}

/**
 * 对请求头中显式携带的 `X-Telegram-Init-Data` / `Authorization` 执行完整形态校验、HMAC-SHA256 签名、`auth_date` 时效、超级管理员 ID 与 30 分钟密码锁定核验。
 * @param request HTTP 请求对象。
 * @returns 校验通过且未锁定时返回 `null`；否则返回结构化拒绝参数。
 */
export function verifyMiniAppHeaderInitDataError(
  request: Request
): Readonly<AccessErrorResponseParams> | null {
  const headerInitCheck: string | Readonly<AccessErrorResponseParams> | null =
    extractVerifiedMiniAppHeaderInitData(request.headers);
  if (headerInitCheck === null) {
    return {
      status: 401,
      code: "MISSING_INIT_DATA",
      reason: "missing_init_data",
      error: "MISSING_INIT_DATA",
    };
  }
  if (typeof headerInitCheck !== "string") {
    return headerInitCheck;
  }

  const hasActiveSession: boolean = hasActiveMiniAppAuthSession(
    extractSessionToken(request)
  );
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData: headerInitCheck,
    secretKey: MINI_APP_INIT_DATA_SECRET_KEY,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    maxAgeSeconds: hasActiveSession
      ? Number.POSITIVE_INFINITY
      : MINI_APP_AUTH_MAX_AGE_SECONDS,
  });
  if (!authResult.ok) {
    const status: number = authResult.reason === "forbidden_user" ? 403 : 401;
    const code: string = authResult.reason.toUpperCase();
    return {
      status,
      code,
      reason: authResult.reason,
      error: code,
    };
  }
  const remainingMinutes: number | null =
    getSuperAdminPasswordLockoutRemainingMinutes();
  if (remainingMinutes !== null) {
    return {
      status: 403,
      code: "PASSWORD_LOCKED",
      reason: "password_locked",
      error: "PASSWORD_LOCKED",
      remainingMinutes,
    };
  }
  return null;
}

/**
 * 校验请求携带的 Telegram WebApp `initData` 签名（或受保护静态/图库资源稳定令牌 `token`）、时效、超级管理员身份与 30 分钟密码锁定状态。
 * 若请求同时携带仍在有效期内的密码认证会话令牌，则放行因持续访问续期而超过初始 45 分钟的静态 `initData.auth_date`（仍严格校验签名、超管身份与未来时钟偏移）。
 * @param ctx 路由请求上下文。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从查询参数提取 `token` 或 `initData`。
 * @returns 验证通过时返回 `null`，失败时返回带真实请求诊断的 `401` 或 `403` `Response`。
 */
function verifyInitDataRequest(
  ctx: Readonly<MiniAppRouteContext>,
  allowQueryAuth: boolean
): Response | null {
  const request: Request = ctx.request;
  const queryUrl: URL | null = allowQueryAuth ? ctx.url : null;
  if (allowQueryAuth) {
    const assetToken: string = extractAssetTokenFromQuery(request, ctx.url);
    if (assetToken.length > 0) {
      if (!verifyMiniAppAssetToken(assetToken, MINI_APP_ASSET_TOKEN_DIGEST)) {
        return accessErrorResponse(request, {
          status: 401,
          code: "INVALID_SIGNATURE",
          reason: "invalid_signature",
          error: "INVALID_SIGNATURE",
        });
      }
      return checkSuperAdminPasswordLockout(request);
    }
  }
  if (!allowQueryAuth) {
    const headerError: Readonly<AccessErrorResponseParams> | null =
      verifyMiniAppHeaderInitDataError(request);
    return headerError === null ? null : accessErrorResponse(request, headerError);
  }
  const initData: string = extractInitDataFromHeaders(request, queryUrl);
  const sessionToken: string = extractSessionToken(request, queryUrl);
  const hasActiveSession: boolean = hasActiveMiniAppAuthSession(sessionToken);
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
    secretKey: MINI_APP_INIT_DATA_SECRET_KEY,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    maxAgeSeconds: hasActiveSession
      ? Number.POSITIVE_INFINITY
      : MINI_APP_AUTH_MAX_AGE_SECONDS,
  });
  if (authResult.ok) {
    return checkSuperAdminPasswordLockout(request);
  }
  const status: number = authResult.reason === "forbidden_user" ? 403 : 401;
  const code: string = authResult.reason.toUpperCase();
  return accessErrorResponse(request, {
    status,
    code,
    reason: authResult.reason,
    error: code,
  });
}

/**
 * 创建校验 Telegram WebApp `initData` HMAC-SHA256 签名、时效、`SUPER_ADMIN_USER_ID` 超管身份及 30 分钟密码锁定状态的中间件（第一层网关校验）。
 * @param allowQueryAuth 是否允许在 `GET`/`HEAD` 请求中从 `token` 或 `initData` 查询参数提取凭据（供受保护图片、SVG 资源与附件下载）。
 * @returns 构造好的 `MiniAppMiddleware`。
 */
export function createMiniAppInitDataMiddleware(allowQueryAuth: boolean): MiniAppMiddleware {
  return (
    ctx: Readonly<MiniAppRouteContext>,
    next: () => Response | Promise<Response>
  ): Response | Promise<Response> =>
    verifyInitDataRequest(ctx, allowQueryAuth) ?? next();
}
