import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import { resolveAndRefreshCheckedMiniAppAuthSession } from "../auth/session";
import { accessErrorResponse } from "../libs/response";

/** `verifyMiniAppSessionAccess` 校验 45 分钟密码会话的入参。 */
export interface VerifyMiniAppSessionAccessOptions {
  /** HTTP 请求对象。 */
  readonly request: Request;
  /** 已提取的 64 位十六进制会话令牌或空字符串。 */
  readonly sessionToken: string;
  /** 前置 `initData` 校验是否已验明 `?token=` 受保护资源令牌。 */
  readonly hasVerifiedAssetToken: boolean;
  /** 策略是否允许在已验明 `?token=` 且未显式携带会话令牌时免检会话。 */
  readonly allowVerifiedAssetTokenBypass: boolean;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/** 第二层密码会话同步校验结果。 */
export type MiniAppSessionAccessResult =
  | { readonly ok: true; readonly session: Readonly<MiniAppAuthSession> | null }
  | { readonly ok: false; readonly response: Response };

/**
 * 同步校验 45 分钟密码认证会话令牌（第二层会话校验）；若已通过 `?token=` 受保护资源令牌核验且策略允许免检、且请求未显式携带会话令牌，则直接放行（`session: null`）。
 * 当有效会话距签发时刻超过 5 分钟时返回刷新后的新会话记录，由调用方在路由处理器返回响应后附加续期响应头。
 * @param options 第二层会话同步校验入参。
 * @returns 校验通过时返回生效会话（或受保护资源免检时的 `null`）；失败时返回 `401` 响应。
 */
export function verifyMiniAppSessionAccess({
  request,
  sessionToken,
  hasVerifiedAssetToken,
  allowVerifiedAssetTokenBypass,
  nowMs,
}: Readonly<VerifyMiniAppSessionAccessOptions>): MiniAppSessionAccessResult {
  if (
    allowVerifiedAssetTokenBypass &&
    hasVerifiedAssetToken &&
    sessionToken.length === 0
  ) {
    return { ok: true, session: null };
  }
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return {
      ok: false,
      response: accessErrorResponse(request, {
        status: 401,
        code: "PASSWORD_REQUIRED",
        reason: "password_required",
        error: "PASSWORD_REQUIRED",
      }),
    };
  }
  const session: Readonly<MiniAppAuthSession> | null =
    resolveAndRefreshCheckedMiniAppAuthSession(sessionToken, nowMs);
  if (session === null) {
    return {
      ok: false,
      response: accessErrorResponse(request, {
        status: 401,
        code: "PASSWORD_REQUIRED",
        reason: "password_required",
        error: "SESSION_EXPIRED",
      }),
    };
  }
  return { ok: true, session };
}
