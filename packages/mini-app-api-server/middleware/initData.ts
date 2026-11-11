import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import { MINI_APP_AUTH_MAX_AGE_SECONDS } from "../../consts/miniApp";
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
  hasActiveMiniAppAuthSession,
} from "../auth/session";
import {
  extractAssetTokenFromQuery,
  extractInitDataFromHeaders,
  extractSessionToken,
} from "../libs/request";
import { accessErrorResponse } from "../libs/response";

/** 模块加载时由 `BOT_TOKEN` 派生一次的 `initData` HMAC-SHA256 验签密钥（进程生命周期内恒定）。 */
const MINI_APP_INIT_DATA_SECRET_KEY: Uint8Array =
  deriveMiniAppInitDataSecretKey(BOT_TOKEN);

/** 模块加载时由 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 派生一次的受保护资源令牌 32 字节摘要（进程生命周期内恒定）。 */
const MINI_APP_ASSET_TOKEN_DIGEST: Uint8Array = deriveMiniAppAssetTokenDigest(
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID
);

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
    if (
      assetToken.length > 0 &&
      verifyMiniAppAssetToken(assetToken, MINI_APP_ASSET_TOKEN_DIGEST)
    ) {
      return checkSuperAdminPasswordLockout(request);
    }
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
