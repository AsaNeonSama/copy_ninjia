import {
  miniAppAuthSessions,
  miniAppAuthSessionWatermark,
} from "../../cache/main/miniApp";
import {
  MINI_APP_SESSION_PREVIOUS_GRACE_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../../consts/miniApp/auth";
import { MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS } from "../../consts/miniAppCrypto";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import { revokeMiniAppGalleryDownloadTicketsForSession } from "./downloadTicket";

/** 会话匹配内部结果（区分命中当前最新令牌 vs 命中并发在途宽限期旧令牌）。 */
export interface MatchedMiniAppAuthSession {
  /** 命中的未过期会话记录。 */
  readonly session: Readonly<MiniAppAuthSession>;
  /** 是否经由尚未被客户端确认替换的 `previousToken` 宽限匹配命中。 */
  readonly matchedViaPrevious: boolean;
}

/** 只读会话查找结果（未提交轮换、未确认作废旧令牌，供解密前鉴权使用）。 */
export interface LookedUpMiniAppSessionState {
  /** 当前最新生效的会话记录快照。 */
  readonly session: Readonly<MiniAppAuthSession>;
  /** 本次请求实际携带并命中的 64 位十六进制会话令牌（供提交阶段复核并发态）。 */
  readonly requestToken: string;
  /** 本次请求是否经由 5 分钟宽限期旧令牌 `previousToken` 命中。 */
  readonly matchedViaPrevious: boolean;
  /** 与请求携带的会话令牌精确匹配的 256-bit `AES-GCM` `CryptoKey`。 */
  readonly matchedCryptoKey: Promise<CryptoKey>;
  /** 与请求匹配密钥纪元对应的已受理请求 IV 去重集合。 */
  readonly matchedSeenRequestIvs: Set<string>;
}

/** 请求加密载荷 IV 重放与单纪元容量核验结果。 */
export type MiniAppSessionRequestIvCheckResult = "ok" | "replay" | "cap_exceeded";

/**
 * 判定一条会话在当前时刻是否仍处于 45 分钟滑动窗口与 2 小时绝对寿命上限之内。
 * @param session 会话记录。
 * @param nowMs 当前毫秒时间戳。
 * @returns 仍在有效期内返回 `true`。
 */
function isMiniAppSessionWithinLifetime(
  session: Readonly<MiniAppAuthSession>,
  nowMs: number
): boolean {
  return session.expiresAt > nowMs && session.absoluteExpiresAt > nowMs;
}

/**
 * 计算单条会话最早需要进入清理扫描的毫秒时刻（45 分钟窗口到期、2 小时绝对寿命到期或 5 分钟宽限字段截止）。
 * @param session 会话记录。
 * @returns 最早需要扫描该会话的毫秒时间戳。
 */
function sessionNextPurgeAt(session: Readonly<MiniAppAuthSession>): number {
  let deadline: number = Math.min(session.expiresAt, session.absoluteExpiresAt);
  if (
    session.previousToken !== undefined ||
    session.pendingSessionKey !== undefined ||
    session.sealedSessionKey !== undefined ||
    session.sealedSessionKeyPromise !== undefined
  ) {
    const graceDeadline: number =
      session.createdAt + MINI_APP_SESSION_PREVIOUS_GRACE_MS + 1;
    if (graceDeadline < deadline) {
      deadline = graceDeadline;
    }
  }
  return deadline;
}

/**
 * 按当前会话表重算最早清理水位；表为空时重置为 `Infinity`。
 */
export function recomputeMiniAppSessionPurgeWatermark(): void {
  if (miniAppAuthSessions.size === 0) {
    miniAppAuthSessionWatermark.nextPurgeAt = Number.POSITIVE_INFINITY;
    return;
  }
  let nextPurgeAt: number = Number.POSITIVE_INFINITY;
  miniAppAuthSessions.forEach((session: Readonly<MiniAppAuthSession>): void => {
    const deadline: number = sessionNextPurgeAt(session);
    if (deadline < nextPurgeAt) {
      nextPurgeAt = deadline;
    }
  });
  miniAppAuthSessionWatermark.nextPurgeAt = nextPurgeAt;
}

/**
 * 写入新会话后按 O(1) 向下收紧清理水位。
 * @param session 刚写入会话表的存活会话。
 */
export function noteMiniAppSessionPurgeDeadline(
  session: Readonly<MiniAppAuthSession>
): void {
  const deadline: number = sessionNextPurgeAt(session);
  if (deadline < miniAppAuthSessionWatermark.nextPurgeAt) {
    miniAppAuthSessionWatermark.nextPurgeAt = deadline;
  }
}

/**
 * 清理已超过 45 分钟窗口或 2 小时绝对寿命上限的会话（同步吊销关联下载票据），
 * 并清除已过 5 分钟并发宽限期（`MINI_APP_SESSION_PREVIOUS_GRACE_MS`）却仍残留的旧令牌、旧密钥、轮换密文与过渡期明文密钥；
 * 当前时刻早于全表最早清理水位时直接 O(1) 返回。
 * @param nowMs 当前毫秒时间戳。
 */
export function purgeExpiredAuthSessions(nowMs: number): void {
  if (miniAppAuthSessions.size === 0) {
    miniAppAuthSessionWatermark.nextPurgeAt = Number.POSITIVE_INFINITY;
    return;
  }
  if (nowMs < miniAppAuthSessionWatermark.nextPurgeAt) {
    return;
  }
  let nextPurgeAt: number = Number.POSITIVE_INFINITY;
  miniAppAuthSessions.forEach(
    (session: Readonly<MiniAppAuthSession>, token: string): void => {
      if (!isMiniAppSessionWithinLifetime(session, nowMs)) {
        miniAppAuthSessions.delete(token);
        revokeMiniAppGalleryDownloadTicketsForSession(session.lineageId);
        return;
      }
      let effectiveSession: Readonly<MiniAppAuthSession> = session;
      if (
        (session.previousToken !== undefined ||
          session.pendingSessionKey !== undefined ||
          session.sealedSessionKey !== undefined ||
          session.sealedSessionKeyPromise !== undefined) &&
        nowMs - session.createdAt > MINI_APP_SESSION_PREVIOUS_GRACE_MS
      ) {
        effectiveSession = {
          ...session,
          previousToken: undefined,
          pendingSessionKey: undefined,
          sealedSessionKey: undefined,
          sealedSessionKeyPromise: undefined,
          previousCryptoKey: undefined,
          previousSeenRequestIvs: undefined,
        };
        miniAppAuthSessions.set(token, effectiveSession);
      }
      const deadline: number = sessionNextPurgeAt(effectiveSession);
      if (deadline < nextPurgeAt) {
        nextPurgeAt = deadline;
      }
    }
  );
  miniAppAuthSessionWatermark.nextPurgeAt = nextPurgeAt;
}

/**
 * 按当前会话令牌或尚未确认替换且在 5 分钟宽限期内的 `previousToken` 查找未过期的二次认证会话。
 * @param token 待核验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 命中时返回会话及匹配来源；未命中或已过期时返回 `null`。
 */
export function findMiniAppAuthSessionMatch(
  token: string,
  nowMs: number
): Readonly<MatchedMiniAppAuthSession> | null {
  const direct: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(token);
  if (direct !== undefined) {
    return isMiniAppSessionWithinLifetime(direct, nowMs)
      ? { session: direct, matchedViaPrevious: false }
      : null;
  }
  for (const session of miniAppAuthSessions.values()) {
    if (
      session.previousToken === token &&
      session.previousCryptoKey !== undefined &&
      isMiniAppSessionWithinLifetime(session, nowMs) &&
      nowMs - session.createdAt <= MINI_APP_SESSION_PREVIOUS_GRACE_MS
    ) {
      return { session, matchedViaPrevious: true };
    }
  }
  return null;
}

/**
 * 按内部谱系标识查找仍在 45 分钟窗口与 2 小时绝对寿命内的会话（同一次登录签发的会话历经多次轮换仍保持同一谱系标识，表中至多一条）。
 * @param lineageId 会话谱系标识。
 * @param nowMs 当前毫秒时间戳。
 * @returns 存活会话；已被登出、锁定、验证器变更吊销或已过期时返回 `undefined`。
 */
export function findLiveMiniAppSessionByLineage(
  lineageId: string,
  nowMs: number
): Readonly<MiniAppAuthSession> | undefined {
  for (const session of miniAppAuthSessions.values()) {
    if (session.lineageId === lineageId) {
      return isMiniAppSessionWithinLifetime(session, nowMs) ? session : undefined;
    }
  }
  return undefined;
}

/**
 * 只读查找给定 64 位十六进制会话令牌对应的未过期会话与匹配密钥句柄，不作废 `previousToken`、不推进轮换且不记录 IV。
 * 供请求解码前阶段核验会话归属使用；仅在后续密文解密与校验完全通过后才调用 `commitMiniAppSessionAccess`。
 * @param sessionToken 已通过格式核验的候选会话令牌。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 命中的只读会话状态；格式非法、缺失或已过期时返回 `null`。
 */
export function lookupMiniAppSessionState(
  sessionToken: string,
  nowMs: number = Date.now()
): Readonly<LookedUpMiniAppSessionState> | null {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return null;
  }
  purgeExpiredAuthSessions(nowMs);
  const match: Readonly<MatchedMiniAppAuthSession> | null =
    findMiniAppAuthSessionMatch(sessionToken, nowMs);
  if (match === null) {
    return null;
  }
  if (match.matchedViaPrevious) {
    return {
      session: match.session,
      requestToken: sessionToken,
      matchedViaPrevious: true,
      matchedCryptoKey: match.session.previousCryptoKey!,
      matchedSeenRequestIvs:
        match.session.previousSeenRequestIvs ?? match.session.seenRequestIvs,
    };
  }
  return {
    session: match.session,
    requestToken: sessionToken,
    matchedViaPrevious: false,
    matchedCryptoKey: match.session.cryptoKey,
    matchedSeenRequestIvs: match.session.seenRequestIvs,
  };
}

/**
 * 查找给定的会话令牌对应的未过期会话（不触发滑动续期，供首屏 `precheck` 及免加密路由核验）。
 * @param sessionToken 待核验的候选会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 未过期会话记录；格式非法、缺失或已过期时返回 `null`。
 */
export function findActiveMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): Readonly<MiniAppAuthSession> | null {
  return lookupMiniAppSessionState(sessionToken, nowMs)?.session ?? null;
}

/**
 * 判断给定的会话令牌在当前时刻是否对应未过期的二次认证会话（含宽限期内的 `previousToken`）。
 * @param sessionToken 待核验的 64 位十六进制会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 会话存在且未过期时返回 `true`。
 */
export function hasActiveMiniAppAuthSession(
  sessionToken: string,
  nowMs: number = Date.now()
): boolean {
  return findActiveMiniAppAuthSession(sessionToken, nowMs) !== null;
}

/**
 * 判断给定的内部会话谱系标识在当前时刻是否对应未过期的二次认证会话。
 * @param lineageId 待核验的会话内部谱系标识。
 * @param nowMs 当前毫秒时间戳。
 * @returns 存在对应谱系的未过期会话时返回 `true`。
 */
export function hasActiveMiniAppAuthSessionByLineage(
  lineageId: string,
  nowMs: number = Date.now()
): boolean {
  if (lineageId.length === 0) {
    return false;
  }
  purgeExpiredAuthSessions(nowMs);
  return findLiveMiniAppSessionByLineage(lineageId, nowMs) !== undefined;
}

/**
 * 核验当前请求携带的加密 IV（信封/查询参数）在当前密钥纪元内是否未发生重放且未超出 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` 上限。
 * @param seenIvs 当前匹配密钥纪元已接受过的 IV 集合。
 * @param incomingIvs 本次待校验请求携带的 IV 字符串列表。
 * @returns `"ok"` 表示可进入解密；`"replay"` 表示同纪元 IV 重放；`"cap_exceeded"` 表示当前密钥纪元 IV 已满上限。
 */
export function evaluateMiniAppSessionRequestIvs(
  seenIvs: ReadonlySet<string>,
  incomingIvs: readonly string[]
): MiniAppSessionRequestIvCheckResult {
  if (incomingIvs.length === 0) {
    return "ok";
  }
  for (let i: number = 0; i < incomingIvs.length; i += 1) {
    const iv: string = incomingIvs[i]!;
    if (seenIvs.has(iv)) {
      return "replay";
    }
    for (let j: number = i + 1; j < incomingIvs.length; j += 1) {
      if (iv === incomingIvs[j]) {
        return "replay";
      }
    }
  }
  if (seenIvs.size + incomingIvs.length > MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS) {
    return "cap_exceeded";
  }
  return "ok";
}
