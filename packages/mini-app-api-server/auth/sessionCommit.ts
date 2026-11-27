import { miniAppAuthSessions } from "../../cache/main/miniApp";
import { MINI_APP_SESSION_TTL_MS } from "../../consts/miniApp/auth";
import {
  MINI_APP_SESSION_KEY_BYTES,
  MINI_APP_SESSION_ROTATE_AT_SEEN_IVS,
} from "../../consts/miniAppCrypto";
import type { MiniAppAuthSession } from "../../types/miniApp/auth";
import {
  generateMiniAppRandomHex,
  importMiniAppAesGcmKey,
  sealRotatedMiniAppSessionKey,
} from "../libs/crypto";
import {
  revokeMiniAppAuthSessionByLineage,
  sampleMiniAppSessionRefreshDelayMs,
} from "./sessionLifecycle";
import {
  evaluateMiniAppSessionRequestIvs,
  findLiveMiniAppSessionByLineage,
  findMiniAppAuthSessionMatch,
  noteMiniAppSessionPurgeDeadline,
  recomputeMiniAppSessionPurgeWatermark,
} from "./sessionLookup";
import type {
  MatchedMiniAppAuthSession,
  MiniAppSessionRequestIvCheckResult,
} from "./sessionLookup";

/** `commitMiniAppSessionAccess` 在请求解密/参数核验通过后提交会话状态的入参。 */
export interface CommitMiniAppSessionAccessOptions {
  /** 前置只读查找命中时的会话记录快照。 */
  readonly session: Readonly<MiniAppAuthSession>;
  /** 请求实际携带的 64 位十六进制会话令牌（缺省按 `matchedViaPrevious` 推断）。 */
  readonly requestToken?: string;
  /** 请求是否经由 5 分钟宽限期旧令牌命中。 */
  readonly matchedViaPrevious: boolean;
  /** 路由策略是否加密响应：为 `true` 时允许到达本代 `nextRefreshAt` 或 `seenRequestIvs.size` 达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` 水位后触发滑动轮换，并允许经 `previousToken` 命中的请求取回尚未确认的轮换密文。 */
  readonly allowRotation: boolean;
  /** 本次请求成功解密并消费的请求 12 字节 IV 列表（Base64）。 */
  readonly acceptedRequestIvs?: readonly string[];
  /** 当前毫秒时间戳（缺省取 `Date.now()`）。 */
  readonly nowMs?: number;
}

/** `commitMiniAppSessionAccess` 提交后的辨别结果（拦截异步解密窗口期内的并发重放、上限超出或会话吊销）。 */
export type CommitMiniAppSessionAccessResult =
  | {
    readonly ok: true;
    /** 提交后的当前活跃会话记录（未发生轮换时保持原会话，发生轮换时为新会话）。 */
    readonly session: Readonly<MiniAppAuthSession>;
    /** 本次请求提交阶段是否触发了新的令牌与密钥滑动轮换。 */
    readonly rotated: boolean;
    /** 本次轮换刚同步启动或封装尚未落定时的共享密文封装 `Promise`（仅解析为 `<ivBase64>.<cipherBase64>` 密文）；无需等待封装时为 `undefined`。 */
    readonly sealedSessionKeyPromise: Promise<string> | undefined;
    /** 经 `previousToken` 命中且新令牌尚未确认、且密文封装已落定时的轮换密文（`sealedSessionKey`）；其余情形为 `undefined`。 */
    readonly redeliveredSealedSessionKey: string | undefined;
  }
  | {
    readonly ok: false;
    readonly reason: "replay" | "cap_exceeded" | "session_expired";
  };

/** `commitMiniAppSessionAccess` 提交成功变体的只读别名（供响应序列化阶段消费）。 */
export type CommittedMiniAppSessionState = Extract<
  CommitMiniAppSessionAccessResult,
  { readonly ok: true }
>;

/** `commitAcceptedRequestIvs` 原子提交请求 IV 的入参。 */
interface CommitAcceptedRequestIvsOptions {
  /** 当前匹配密钥纪元已接受过的 IV 去重集合。 */
  readonly seenIvs: Set<string> | undefined;
  /** 本次请求携带并待登记的已消费 IV 列表。 */
  readonly acceptedRequestIvs: readonly string[] | undefined;
  /** 触发 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` 硬上限时待吊销的会话内部谱系标识。 */
  readonly sessionLineageIdToRevoke: string;
  /** 当前毫秒时间戳。 */
  readonly nowMs: number;
}

/**
 * 内部复用：在当前密钥纪元上同步复核并写入已消费 IV，超限时立即按谱系吊销整条会话及关联下载票据。
 * @param options IV 集合、待登记 IV 列表、待吊销会话谱系标识与当前时间戳。
 * @returns 提交状态：`"ok"`、`"replay"` 或 `"cap_exceeded"`。
 */
function commitAcceptedRequestIvs({
  seenIvs,
  acceptedRequestIvs,
  sessionLineageIdToRevoke,
  nowMs,
}: Readonly<CommitAcceptedRequestIvsOptions>): "ok" | "replay" | "cap_exceeded" {
  if (
    seenIvs === undefined ||
    acceptedRequestIvs === undefined ||
    acceptedRequestIvs.length === 0
  ) {
    return "ok";
  }
  const check: MiniAppSessionRequestIvCheckResult =
    evaluateMiniAppSessionRequestIvs(seenIvs, acceptedRequestIvs);
  if (check === "cap_exceeded") {
    revokeMiniAppAuthSessionByLineage(sessionLineageIdToRevoke, nowMs);
    return "cap_exceeded";
  }
  if (check === "replay") {
    return "replay";
  }
  for (const iv of acceptedRequestIvs) {
    seenIvs.add(iv);
  }
  return "ok";
}

/**
 * 在滑动轮换封装完成时，将经上一代密钥封装的新密钥密文记入会话记录并清除在途共享封装 `Promise`；
 * 会话已被吊销或新令牌已被确认（不再持有 `previousToken`）时不回写密文。
 * @param sessionToken 轮换后的新会话令牌。
 * @param sealedSessionKey `sealRotatedMiniAppSessionKey` 产出的 `<ivBase64>.<cipherBase64>` 密文。
 */
function recordSealedMiniAppSessionKey(
  sessionToken: string,
  sealedSessionKey: string
): void {
  const existing: Readonly<MiniAppAuthSession> | undefined =
    miniAppAuthSessions.get(sessionToken);
  if (existing === undefined) {
    return;
  }
  miniAppAuthSessions.set(sessionToken, {
    ...existing,
    pendingSessionKey: undefined,
    sealedSessionKey:
      existing.previousToken !== undefined ? sealedSessionKey : undefined,
    sealedSessionKeyPromise: undefined,
  });
  recomputeMiniAppSessionPurgeWatermark();
}

/**
 * 在加密请求已成功通过认证标签解密与参数校验后，原子复核并提交会话访问状态：
 * 1. 复查请求令牌对应的活跃状态与密钥纪元；令牌已不可匹配时（解密窗口内被轮换并确认），按谱系标识定位存活会话，
 *    仍存活即在只读查找时所属密钥纪元的 IV 集合上提交且不轮换，已被登出/锁定/吊销/过期则拒绝；
 * 2. 在所属密钥纪元上再次同步核验并写入已消费请求 IV（拦截并发相同 IV 重放及超出 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` 硬上限时按谱系吊销会话）；
 * 3. 经 `previousToken` 命中且允许轮换时，返回尚未确认的已落定轮换密文或仍在封装中的共享密文 `Promise` 供响应重新附带；
 * 4. 若命中最新令牌，立即作废 `previousToken`、`previousCryptoKey`、`previousSeenRequestIvs`、轮换密文、共享封装 `Promise` 及过渡明文密钥；
 * 5. 若允许滑动轮换且已到达本代 `nextRefreshAt` 或当前密钥纪元 `seenRequestIvs.size` 已达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` 水位，生成新会话令牌与新 256-bit 密钥、同步启动共享密文封装 `Promise`、重置新纪元 `seenRequestIvs` 与随机轮换冷却时间。
 * @param options 会话快照、请求令牌、匹配来源、轮换允许标志及已消费 IV 列表。
 * @returns 提交后的会话状态、是否发生轮换、共享密文封装 `Promise` 与已落定轮换密文，或并发重放/上限/失效拒绝原因。
 */
export function commitMiniAppSessionAccess({
  session,
  requestToken,
  matchedViaPrevious,
  allowRotation,
  acceptedRequestIvs,
  nowMs = Date.now(),
}: Readonly<CommitMiniAppSessionAccessOptions>): CommitMiniAppSessionAccessResult {
  const effectiveToken: string =
    requestToken ??
    (matchedViaPrevious ? (session.previousToken ?? session.token) : session.token);
  const match: Readonly<MatchedMiniAppAuthSession> | null =
    findMiniAppAuthSessionMatch(effectiveToken, nowMs);
  if (match === null) {
    const liveSession: Readonly<MiniAppAuthSession> | undefined =
      findLiveMiniAppSessionByLineage(session.lineageId, nowMs);
    if (liveSession === undefined) {
      return { ok: false, reason: "session_expired" };
    }
    const lineageIvStatus: "ok" | "replay" | "cap_exceeded" =
      commitAcceptedRequestIvs({
        seenIvs: matchedViaPrevious
          ? (session.previousSeenRequestIvs ?? session.seenRequestIvs)
          : session.seenRequestIvs,
        acceptedRequestIvs,
        sessionLineageIdToRevoke: liveSession.lineageId,
        nowMs,
      });
    if (lineageIvStatus !== "ok") {
      return { ok: false, reason: lineageIvStatus };
    }
    return {
      ok: true,
      session: liveSession,
      rotated: false,
      sealedSessionKeyPromise: undefined,
      redeliveredSealedSessionKey: undefined,
    };
  }

  const targetSeenIvs: Set<string> | undefined = match.matchedViaPrevious
    ? match.session.previousSeenRequestIvs
    : match.session.seenRequestIvs;
  const ivStatus: "ok" | "replay" | "cap_exceeded" = commitAcceptedRequestIvs({
    seenIvs: targetSeenIvs,
    acceptedRequestIvs,
    sessionLineageIdToRevoke: match.session.lineageId,
    nowMs,
  });
  if (ivStatus !== "ok") {
    return { ok: false, reason: ivStatus };
  }

  if (match.matchedViaPrevious) {
    return {
      ok: true,
      session: match.session,
      rotated: false,
      sealedSessionKeyPromise: allowRotation
        ? match.session.sealedSessionKeyPromise
        : undefined,
      redeliveredSealedSessionKey: allowRotation
        ? match.session.sealedSessionKey
        : undefined,
    };
  }

  let activeSession: Readonly<MiniAppAuthSession> = match.session;
  // 客户端首次携带新令牌并成功解密请求后：确认已完成续期替换，立即作废上一轮令牌、旧密钥、旧 IV 集合、轮换密文及共享封装 Promise。
  if (
    activeSession.previousToken !== undefined ||
    activeSession.pendingSessionKey !== undefined ||
    activeSession.sealedSessionKey !== undefined ||
    activeSession.sealedSessionKeyPromise !== undefined
  ) {
    activeSession = {
      ...activeSession,
      previousToken: undefined,
      pendingSessionKey: undefined,
      sealedSessionKey: undefined,
      sealedSessionKeyPromise: undefined,
      previousCryptoKey: undefined,
      previousSeenRequestIvs: undefined,
    };
    miniAppAuthSessions.set(activeSession.token, activeSession);
    recomputeMiniAppSessionPurgeWatermark();
  }

  const shouldRotate: boolean =
    nowMs >= activeSession.nextRefreshAt ||
    activeSession.seenRequestIvs.size >= MINI_APP_SESSION_ROTATE_AT_SEEN_IVS;
  if (!allowRotation || !shouldRotate) {
    return {
      ok: true,
      session: activeSession,
      rotated: false,
      sealedSessionKeyPromise: undefined,
      redeliveredSealedSessionKey: undefined,
    };
  }

  const newToken: string = generateMiniAppRandomHex(MINI_APP_SESSION_KEY_BYTES);
  const newSessionKey: string = generateMiniAppRandomHex(MINI_APP_SESSION_KEY_BYTES);
  const sealedSessionKeyPromise: Promise<string> = activeSession.cryptoKey
    .then(
      (oldKey: CryptoKey): Promise<string> =>
        sealRotatedMiniAppSessionKey(oldKey, newSessionKey, newToken)
    )
    .then((sealed: string): string => {
      recordSealedMiniAppSessionKey(newToken, sealed);
      return sealed;
    });
  const refreshed: Readonly<MiniAppAuthSession> = {
    lineageId: activeSession.lineageId,
    token: newToken,
    previousToken: activeSession.token,
    pendingSessionKey: undefined,
    sealedSessionKey: undefined,
    sealedSessionKeyPromise,
    cryptoKey: importMiniAppAesGcmKey(newSessionKey),
    seenRequestIvs: new Set<string>(),
    previousCryptoKey: activeSession.cryptoKey,
    previousSeenRequestIvs: activeSession.seenRequestIvs,
    issuedAt: activeSession.issuedAt,
    createdAt: nowMs,
    nextRefreshAt: nowMs + sampleMiniAppSessionRefreshDelayMs(),
    expiresAt: Math.min(
      nowMs + MINI_APP_SESSION_TTL_MS,
      activeSession.absoluteExpiresAt
    ),
    absoluteExpiresAt: activeSession.absoluteExpiresAt,
  };
  miniAppAuthSessions.delete(activeSession.token);
  miniAppAuthSessions.set(newToken, refreshed);
  noteMiniAppSessionPurgeDeadline(refreshed);
  return {
    ok: true,
    session: refreshed,
    rotated: true,
    sealedSessionKeyPromise,
    redeliveredSealedSessionKey: undefined,
  };
}
