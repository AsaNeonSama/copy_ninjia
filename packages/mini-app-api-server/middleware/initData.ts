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
import type { MiniAppRouteContext } from "../../types/miniApp/server";
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

/** 内部统一校验 `initData` 签名、超管身份与密码锁定状态的入参。 */
interface VerifyInitDataSignatureAndLockoutOptions {
  /** 待校验的 Telegram WebApp `initData` 原始查询串。 */
  readonly initData: string;
  /** 请求携带的 64 位十六进制会话令牌或空字符串。 */
  readonly sessionToken: string;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/** `verifyMiniAppInitDataAccess` 第一层网关凭据校验的入参。 */
export interface VerifyMiniAppInitDataAccessOptions {
  /** 路由请求上下文。 */
  readonly ctx: Readonly<MiniAppRouteContext>;
  /** 是否允许在 `GET`/`HEAD` 请求中从 `token` 或 `initData` 查询参数提取凭据。 */
  readonly allowQueryAuth: boolean;
  /** 请求头快路径校验已提取的 `initData`（缺省时为 `null`）。 */
  readonly headerInitData: string | null;
  /** 已提取的 64 位十六进制会话令牌或空字符串。 */
  readonly sessionToken: string;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/** 第一层 `initData` / 受保护资源令牌同步校验结果。 */
export type MiniAppInitDataAccessResult =
  | { readonly ok: true; readonly hasVerifiedAssetToken: boolean }
  | { readonly ok: false; readonly response: Response };

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
 * 对 `initData` 签名、`auth_date` 时效（有效会话免过期）、超管身份与 30 分钟密码锁定执行统一校验。
 * @param options 待校验的 `initData`、会话令牌与当前时间戳。
 * @returns 校验通过且未锁定时返回 `null`；否则返回结构化拒绝参数。
 */
function verifyInitDataSignatureAndLockout({
  initData,
  sessionToken,
  nowMs,
}: Readonly<VerifyInitDataSignatureAndLockoutOptions>): Readonly<AccessErrorResponseParams> | null {
  const hasActiveSession: boolean = hasActiveMiniAppAuthSession(
    sessionToken,
    nowMs
  );
  const authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
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
    getSuperAdminPasswordLockoutRemainingMinutes(nowMs);
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
 * 对请求头中显式携带的 `X-Telegram-Init-Data` / `Authorization` 执行完整形态校验、HMAC-SHA256 签名、`auth_date` 时效、超级管理员 ID 与 30 分钟密码锁定核验。
 * @param request HTTP 请求对象。
 * @param nowMs 当前毫秒时间戳。
 * @returns 校验通过且未锁定时返回 `null`；否则返回结构化拒绝参数。
 */
export function verifyMiniAppHeaderInitDataError(
  request: Request,
  nowMs: number = Date.now()
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
  return verifyInitDataSignatureAndLockout({
    initData: headerInitCheck,
    sessionToken: extractSessionToken(request),
    nowMs,
  });
}

/**
 * 同步校验请求携带的 Telegram WebApp `initData` 签名（或受保护静态/图库资源稳定令牌 `?token=`）、时效、超级管理员身份与 30 分钟密码锁定状态。
 * 复用 `verifyMiniAppRequestHeadersFast` 已提取的请求头 `initData` 与上层已提取的会话令牌，避免重复解析请求头。
 * @param options 网关第一层同步校验入参。
 * @returns 校验通过时标记是否已验明受保护资源令牌；失败时返回带真实请求诊断的 `401` 或 `403` `Response`。
 */
export function verifyMiniAppInitDataAccess({
  ctx,
  allowQueryAuth,
  headerInitData,
  sessionToken,
  nowMs,
}: Readonly<VerifyMiniAppInitDataAccessOptions>): MiniAppInitDataAccessResult {
  const request: Request = ctx.request;
  if (allowQueryAuth) {
    const assetToken: string = extractAssetTokenFromQuery(request, ctx.url);
    if (assetToken.length > 0) {
      if (!verifyMiniAppAssetToken(assetToken, MINI_APP_ASSET_TOKEN_DIGEST)) {
        return {
          ok: false,
          response: accessErrorResponse(request, {
            status: 401,
            code: "INVALID_SIGNATURE",
            reason: "invalid_signature",
            error: "INVALID_SIGNATURE",
          }),
        };
      }
      const lockoutResponse: Response | null = checkSuperAdminPasswordLockout(
        request,
        nowMs
      );
      if (lockoutResponse !== null) {
        return { ok: false, response: lockoutResponse };
      }
      return { ok: true, hasVerifiedAssetToken: true };
    }
  }

  const initData: string =
    headerInitData ??
    (allowQueryAuth ? extractInitDataFromHeaders(request, ctx.url) : "");
  const errorParams: Readonly<AccessErrorResponseParams> | null =
    verifyInitDataSignatureAndLockout({
      initData,
      sessionToken,
      nowMs,
    });
  if (errorParams !== null) {
    return {
      ok: false,
      response: accessErrorResponse(request, errorParams),
    };
  }
  return { ok: true, hasVerifiedAssetToken: false };
}
