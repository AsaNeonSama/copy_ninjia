import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import { lookupMiniAppSessionState } from "../auth/session";
import type { LookedUpMiniAppSessionState } from "../auth/session";
import { accessErrorResponse } from "../libs/response";

/** `verifyMiniAppSessionAccess` 校验 45 分钟二次认证会话的入参。 */
export interface VerifyMiniAppSessionAccessOptions {
  /** HTTP 请求对象。 */
  readonly request: Request;
  /** 已提取的 64 位十六进制会话令牌或空字符串。 */
  readonly sessionToken: string;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/** 第二层二次认证会话同步只读校验结果。 */
export type MiniAppSessionAccessResult =
  | {
    readonly ok: true;
    readonly sessionState: Readonly<LookedUpMiniAppSessionState>;
  }
  | { readonly ok: false; readonly response: Response };

/**
 * 同步执行第二层 45 分钟二次认证会话只读核验（不作废 `previousToken`、不推进轮换且不记录 IV）；
 * 仅在后续请求解密与校验完全通过后，再由管道调用 `commitMiniAppSessionAccess` 提交状态变更。
 * @param options 第二层会话同步校验入参。
 * @returns 校验通过时返回只读会话状态；缺失、格式非法或已过期时返回 `401` 响应。
 */
export function verifyMiniAppSessionAccess({
  request,
  sessionToken,
  nowMs,
}: Readonly<VerifyMiniAppSessionAccessOptions>): MiniAppSessionAccessResult {
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
  const lookedUp: Readonly<LookedUpMiniAppSessionState> | null =
    lookupMiniAppSessionState(sessionToken, nowMs);
  if (lookedUp === null) {
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
  return {
    ok: true,
    sessionState: lookedUp,
  };
}
