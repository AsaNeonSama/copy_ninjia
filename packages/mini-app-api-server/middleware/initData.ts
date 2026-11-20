import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_MAX_LIFETIME_MS,
  MINI_APP_SESSION_TTL_MS,
} from "../../consts/miniApp";
import {
  deriveMiniAppInitDataSecretKey,
  verifyMiniAppInitData,
} from "../../libs/miniAppAuth";
import type { MiniAppAuthResult } from "../../types/miniApp/auth";
import { hasActiveMiniAppAuthSession } from "../auth/session";
import { getSuperAdminPasswordLockoutRemainingMinutes } from "../auth/lockout";
import { extractSessionToken } from "../libs/request";
import { accessErrorResponse } from "../libs/response";
import type { AccessErrorResponseParams } from "../libs/response";
import { extractVerifiedMiniAppHeaderInitData } from "./headerGuard";

/** 模块加载时由 `BOT_TOKEN` 派生一次的 `initData` HMAC-SHA256 验签密钥（进程生命周期内恒定）。 */
const MINI_APP_INIT_DATA_SECRET_KEY: Uint8Array =
  deriveMiniAppInitDataSecretKey(BOT_TOKEN);

/** 持有活跃二次认证会话时允许 `initData` `auth_date` 延续的最大秒数（2 小时绝对寿命 + 45 分钟窗口 = 2 小时 45 分钟）。 */
const MINI_APP_ACTIVE_SESSION_INIT_DATA_MAX_AGE_SECONDS: number = Math.floor(
  (MINI_APP_SESSION_MAX_LIFETIME_MS + MINI_APP_SESSION_TTL_MS) / 1_000
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
  /** HTTP 请求对象。 */
  readonly request: Request;
  /** 请求头快路径校验已提取的 `initData`。 */
  readonly headerInitData: string;
  /** 已提取的 64 位十六进制会话令牌或空字符串。 */
  readonly sessionToken: string;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/** 第一层 `initData` 同步校验结果。 */
export type MiniAppInitDataAccessResult =
  | { readonly ok: true }
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
 * 对 `initData` 签名、`auth_date` 时效（有效会话放宽至 2 小时 45 分钟上限）、超管身份与 30 分钟密码锁定执行统一校验。
 * @param options 待校验的 `initData`、会话令牌与当前时间戳。
 * @returns 校验通过且未锁定时返回 `null`；否则返回结构化拒绝参数。
 */
function verifyInitDataSignatureAndLockout({
  initData,
  sessionToken,
  nowMs,
}: Readonly<VerifyInitDataSignatureAndLockoutOptions>): Readonly<AccessErrorResponseParams> | null {
  let authResult: MiniAppAuthResult = verifyMiniAppInitData({
    initData,
    secretKey: MINI_APP_INIT_DATA_SECRET_KEY,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    maxAgeSeconds: MINI_APP_AUTH_MAX_AGE_SECONDS,
    nowMs,
  });
  if (
    !authResult.ok &&
    authResult.reason === "expired_auth_date" &&
    hasActiveMiniAppAuthSession(sessionToken, nowMs)
  ) {
    authResult = verifyMiniAppInitData({
      initData,
      secretKey: MINI_APP_INIT_DATA_SECRET_KEY,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      maxAgeSeconds: MINI_APP_ACTIVE_SESSION_INIT_DATA_MAX_AGE_SECONDS,
      nowMs,
    });
  }
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
 * 校验请求头中显式携带的 `X-Telegram-Init-Data` / `Authorization`：依次核验基础形态、HMAC-SHA256 签名、`auth_date` 时效（持有有效会话放宽至 2 小时 45 分钟）、超级管理员 ID 与 30 分钟锁定期。
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
 * 同步执行第一层网关身份校验：基于请求头快路径提取的 `initData` 与会话令牌，核验 Telegram WebApp 签名、时效、超级管理员身份及 30 分钟锁定期。
 * @param options 网关第一层同步校验入参。
 * @returns 校验通过返回 `{ ok: true }`；失败时返回带请求诊断的 `401` 或 `403` `Response`。
 */
export function verifyMiniAppInitDataAccess({
  request,
  headerInitData,
  sessionToken,
  nowMs,
}: Readonly<VerifyMiniAppInitDataAccessOptions>): MiniAppInitDataAccessResult {
  const errorParams: Readonly<AccessErrorResponseParams> | null =
    verifyInitDataSignatureAndLockout({
      initData: headerInitData,
      sessionToken,
      nowMs,
    });
  if (errorParams !== null) {
    return {
      ok: false,
      response: accessErrorResponse(request, errorParams),
    };
  }
  return { ok: true };
}
