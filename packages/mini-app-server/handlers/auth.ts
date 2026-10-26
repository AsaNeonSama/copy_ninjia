import {
  miniAppActiveConfigHolder, miniAppAuthSessions, miniAppPasswordGuardHolder,
} from "../../cache/main/miniApp";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } from "../../config/bot";
import {
  MINI_APP_FALLBACK_TEST_PASSWORD, MINI_APP_PASSWORD_LOCKOUT_MS, MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_TTL_MS, MINI_APP_SHA256_HEX_PATTERN,
} from "../../consts/miniApp";
import { chatAtmosphere } from "../../infra/atmosphere";
import { sendMessage } from "../../infra/telegram/actions/messages";
import { deriveMiniAppAssetToken, verifyMiniAppPassword } from "../../libs/miniAppAuth";
import { verifyMiniAppTotpCode } from "../../libs/miniAppTotp";
import { formatLocalTime } from "../../libs/time";
import type { BotMiniAppConfig } from "../../types/config";
import type {
  MiniAppAuthSession, MiniAppLoginSuccessResponse, MiniAppPasswordGuardState,
} from "../../types/miniApp";
import type { MiniAppTotpRecord } from "../../types/miniAppTotp";
import { extractSessionToken, readJsonObjectBody, resolveSafeClientIp } from "../libs/request";
import { accessErrorResponse, jsonResponse } from "../libs/response";
import {
  checkSuperAdminPasswordLockout, issueMiniAppAuthSession, purgeExpiredAuthSessions,
} from "../session";
import { loadMiniAppTotpRecord } from "../totpStorage";

/**
 * 处理 `GET /api/auth/precheck`：在前置中间件链完成 SuperAdmin `initData` 签名与密码锁定核验后，返回会话 TTL、TOTP 启用状态、持久化会话是否有效及受保护资源缓存令牌。
 * @param request 可选 HTTP 请求对象（用于核验客户端持久化的 45 分钟会话令牌）。
 * @returns JSON 响应。
 */
export async function handleGetAuthPrecheckRoute(request?: Request): Promise<Response> {
  const totpRecord: Readonly<MiniAppTotpRecord> | null = await loadMiniAppTotpRecord();
  const totpEnabled: boolean = totpRecord !== null;
  const nowMs: number = Date.now();
  purgeExpiredAuthSessions(nowMs);
  const sessionToken: string = request !== undefined ? extractSessionToken(request) : "";
  const activeSession: Readonly<MiniAppAuthSession> | undefined =
    MINI_APP_SHA256_HEX_PATTERN.test(sessionToken) ? miniAppAuthSessions.get(sessionToken) : undefined;
  return jsonResponse({
    ok: true,
    ttlMs: MINI_APP_SESSION_TTL_MS,
    totpEnabled,
    authMode: totpEnabled ? "totp" : "password",
    assetToken: deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID),
    ...(activeSession !== undefined && activeSession.expiresAt > nowMs
      ? { sessionValid: true, sessionExpiresAt: activeSession.expiresAt }
      : {}),
  });
}

/**
 * 处理 `POST /api/auth/login`：在前置中间件链完成 SuperAdmin `initData` 签名核验后，若已启用 Google Authenticator 则优先校验 6 位 TOTP 动态码，否则校验 `mini_app.password`（连续输错 3 次锁定该超级管理员 ID 30 分钟），通过后签发 45 分钟会话令牌。
 * 读取请求体与 TOTP 记录后若锁定已生效（由并发登录在等待期间触发），不比对凭据，按失败计数并将锁定顺延至当前时刻起 30 分钟。
 * 由未锁定转入锁定时向超级管理员私聊发送一条告警（不等待发送结果，失败走统一 Telegram 错误日志）；锁定顺延不重复告警。
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
    const expectedPassword: string =
      activeConfig?.password ?? MINI_APP_FALLBACK_TEST_PASSWORD;
    verified = verifyMiniAppPassword(inputPassword, expectedPassword);
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
      return checkSuperAdminPasswordLockout(request, nowMs)!;
    }
    miniAppPasswordGuardHolder.current = {
      userId: SUPER_ADMIN_USER_ID,
      failedAttempts: nextAttempts,
      lockedUntil: 0,
    };
    const remaining: number = MINI_APP_PASSWORD_MAX_ATTEMPTS - nextAttempts;
    return accessErrorResponse(request, {
      status: 403,
      code: totpRecord !== null ? "INVALID_TOTP_CODE" : "INVALID_PASSWORD",
      reason: "invalid_password",
      error:
        totpRecord !== null
          ? `Google Authenticator 6 位动态验证码错误，还剩 ${remaining} 次尝试机会（连续输错 ${MINI_APP_PASSWORD_MAX_ATTEMPTS} 次将锁定 30 分钟）。`
          : `访问密码错误，还剩 ${remaining} 次尝试机会（连续输错 ${MINI_APP_PASSWORD_MAX_ATTEMPTS} 次将锁定 30 分钟）。`,
    });
  }

  miniAppPasswordGuardHolder.current = null;
  const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(nowMs);
  const response: MiniAppLoginSuccessResponse = {
    ok: true,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    ttlMs: MINI_APP_SESSION_TTL_MS,
    assetToken: deriveMiniAppAssetToken(BOT_TOKEN, SUPER_ADMIN_USER_ID),
  };
  return jsonResponse(response);
}
