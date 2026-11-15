import {
  miniAppActiveConfigHolder, miniAppAuthSessions, miniAppPasswordGuardHolder,
} from "../../cache/main/miniApp";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_PASSWORD_LOCKOUT_MS, MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_TTL_MS,
} from "../../consts/miniApp";
import { chatAtmosphere } from "../../infra/atmosphere";
import { sendMessage } from "../../infra/telegram/actions/messages";
import { deriveMiniAppAssetToken, verifyMiniAppPassword } from "../../libs/miniAppAuth";
import { verifyMiniAppTotpCode } from "../../libs/miniAppTotp";
import { formatLocalTime } from "../../libs/time";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAuthPrecheckResponse,
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
  MiniAppPasswordGuardState,
} from "../../types/miniApp/auth";
import type { MiniAppTotpRecord } from "../../types/miniAppTotp";
import {
  attachClearMiniAppPageGateCookie,
  attachMiniAppPageGateCookie,
} from "../auth/pageGate";
import {
  attachRefreshedSessionHeaders,
  checkSuperAdminPasswordLockout, issueMiniAppAuthSession,
  resolveAndRefreshMiniAppAuthSession, revokeMiniAppAuthSession,
} from "../auth/session";
import { loadMiniAppTotpRecord } from "../auth/totpStorage";
import { extractSessionToken, readJsonObjectBody, resolveSafeClientIp } from "../libs/request";
import { accessErrorResponse, jsonResponse } from "../libs/response";

/** 模块加载时由 `BOT_TOKEN` 与 `SUPER_ADMIN_USER_ID` 派生一次的受保护静态/图库资源十六进制令牌（进程生命周期内恒定）。 */
const MINI_APP_ASSET_TOKEN: string = deriveMiniAppAssetToken(
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID
);

/**
 * 处理 `GET /api/auth/precheck`：在前置鉴权策略完成超级管理员 `initData` 签名与锁定期核验后，返回会话 TTL、TOTP 启用状态及当前二次认证会话是否有效，并签发最新单页门禁 Cookie。
 * 仅当 45 分钟解锁会话仍有效时一并下发受保护资源令牌 `assetToken`；若会话距签发已超过 5 分钟则轮换令牌并顺延有效期。
 * @param request 可选 HTTP 请求对象（用于核验客户端持久化的会话令牌及附加 `Set-Cookie`）。
 * @returns JSON 响应。
 */
export async function handleGetAuthPrecheckRoute(request?: Request): Promise<Response> {
  const totpRecord: Readonly<MiniAppTotpRecord> | null = await loadMiniAppTotpRecord();
  const totpEnabled: boolean = totpRecord !== null;
  const nowMs: number = Date.now();
  const sessionToken: string = request !== undefined ? extractSessionToken(request) : "";
  const activeSession: Readonly<MiniAppAuthSession> | null =
    resolveAndRefreshMiniAppAuthSession(sessionToken, nowMs);
  const payload: MiniAppAuthPrecheckResponse = {
    ok: true,
    ttlMs: MINI_APP_SESSION_TTL_MS,
    totpEnabled,
    authMode: totpEnabled ? "totp" : "password",
    ...(activeSession !== null
      ? {
        sessionValid: true,
        sessionExpiresAt: activeSession.expiresAt,
        ...(activeSession.token !== sessionToken
          ? { sessionToken: activeSession.token }
          : {}),
        assetToken: MINI_APP_ASSET_TOKEN,
      }
      : {}),
  };
  const response: Response = jsonResponse(payload);
  if (request !== undefined) {
    attachMiniAppPageGateCookie(response, request, nowMs);
  }
  if (activeSession !== null && activeSession.token !== sessionToken) {
    return attachRefreshedSessionHeaders(response, activeSession);
  }
  return response;
}

/**
 * 处理 `POST /api/auth/login`：在前置鉴权策略完成超级管理员 `initData` 签名核验后，若已启用 Google Authenticator 则校验 6 位动态码，否则校验 `mini_app.password`；通过后签发 45 分钟二次认证会话令牌并刷新单页门禁 Cookie。
 * 连续输错满 3 次时锁定超级管理员 ID 30 分钟、清空全部已登录会话并清除门禁 Cookie。若等待读取请求体或 TOTP 记录期间已由并发请求触发锁定，则不再比对凭据，直接累加失败次数并将锁定期顺延至当前时刻起 30 分钟。
 * 由未锁定首次转入锁定时向超级管理员私聊发送告警（异步发送，失败记统一 Telegram 错误日志）；锁定期顺延不重复告警。
 * @param request HTTP 请求对象。
 * @returns JSON 响应。
 */
export async function handlePostAuthLoginRoute(request: Request): Promise<Response> {
  const body: Record<string, unknown> | null = await readJsonObjectBody(request);
  const totpRecord: Readonly<MiniAppTotpRecord> | null = await loadMiniAppTotpRecord();
  const nowMs: number = Date.now();
  // 自此读取锁定状态到失败计数更新为止不得插入 await。
  const guard: Readonly<MiniAppPasswordGuardState> | null = miniAppPasswordGuardHolder.current;
  const locked: boolean = guard?.userId === SUPER_ADMIN_USER_ID && guard.lockedUntil > nowMs;

  let verified: boolean;
  if (locked) {
    verified = false;
  } else if (totpRecord !== null) {
    const inputCode: string =
      typeof body?.totpCode === "string"
        ? body.totpCode.trim()
        : typeof body?.password === "string"
          ? body.password.trim()
          : "";
    verified = verifyMiniAppTotpCode(inputCode, totpRecord.secret, nowMs);
  } else {
    const inputPassword: string =
      typeof body?.password === "string" ? body.password.trim() : "";
    const activeConfig: Readonly<BotMiniAppConfig> | undefined =
      miniAppActiveConfigHolder.current ?? getBotMiniAppConfig();
    verified =
      activeConfig !== undefined &&
      verifyMiniAppPassword(inputPassword, activeConfig.password);
  }

  if (!verified) {
    const prevAttempts: number =
      guard?.userId === SUPER_ADMIN_USER_ID && (guard.lockedUntil === 0 || locked)
        ? guard.failedAttempts
        : 0;
    const nextAttempts: number = prevAttempts + 1;
    if (nextAttempts >= MINI_APP_PASSWORD_MAX_ATTEMPTS) {
      const lockedUntil: number = nowMs + MINI_APP_PASSWORD_LOCKOUT_MS;
      miniAppPasswordGuardHolder.current = {
        userId: SUPER_ADMIN_USER_ID,
        failedAttempts: nextAttempts,
        lockedUntil,
      };
      miniAppAuthSessions.clear();
      if (!locked) {
        void sendMessage({
          chatId: SUPER_ADMIN_USER_ID,
          text: chatAtmosphere().NOTICE_TEXTS.miniAppLoginLocked(
            nextAttempts,
            formatLocalTime(lockedUntil),
            resolveSafeClientIp(request)
          ),
        });
      }
      return attachClearMiniAppPageGateCookie(
        checkSuperAdminPasswordLockout(request, nowMs)!,
        request
      );
    }
    miniAppPasswordGuardHolder.current = {
      userId: SUPER_ADMIN_USER_ID,
      failedAttempts: nextAttempts,
      lockedUntil: 0,
    };
    const remaining: number = MINI_APP_PASSWORD_MAX_ATTEMPTS - nextAttempts;
    const errorCode: string = totpRecord !== null ? "INVALID_TOTP_CODE" : "INVALID_PASSWORD";
    return accessErrorResponse(request, {
      status: 403,
      code: errorCode,
      reason: "invalid_password",
      error: errorCode,
      remainingAttempts: remaining,
    });
  }

  miniAppPasswordGuardHolder.current = null;
  const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(nowMs);
  const response: MiniAppLoginSuccessResponse = {
    ok: true,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    ttlMs: MINI_APP_SESSION_TTL_MS,
    assetToken: MINI_APP_ASSET_TOKEN,
  };
  return attachMiniAppPageGateCookie(jsonResponse(response), request, nowMs);
}

/**
 * 处理 `POST /api/auth/logout`：在前置鉴权策略完成超级管理员 `initData` 签名与锁定期核验后，
 * 吊销请求头 `X-Mini-App-Session` 携带的二次认证会话（不刷新、不续期）；会话已过期或不存在时同样返回成功。
 * @param request HTTP 请求对象。
 * @returns JSON 响应（`revoked` 表示是否删除了仍有效的会话）。
 */
export function handlePostAuthLogoutRoute(request: Request): Response {
  const revoked: boolean = revokeMiniAppAuthSession(extractSessionToken(request));
  return jsonResponse({ ok: true, revoked });
}
