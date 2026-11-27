/**
 * Mini App 单密钥纪元 AES-256-GCM 请求 IV 硬上限（4,096）与 IV 水位（3,072）主动滑动密钥轮换专项测试：
 * 覆盖未达水位不轮换、未到 `nextRefreshAt` 先达水位即提前轮换并重置 IV 集合与随机冷却时间、
 * 旧纪元并发在途余量与重新附带密文、非轮换二进制路由（`/api/gallery/file`）与硬上限吊销、
 * 2 小时绝对寿命封顶以及 `400` 失败解密绝不触发轮换。
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
} from "../../packages/types/miniApp/auth";
import type { MiniAppEncryptedEnvelope } from "../../packages/types/miniApp/configs";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppAuthSessionWatermark,
  miniAppGalleryDownloadTickets,
  miniAppPasswordGuardHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_MAX_LIFETIME_MS,
  MINI_APP_SESSION_PREVIOUS_GRACE_MS,
  MINI_APP_SESSION_REFRESH_MAX_MS,
  MINI_APP_SESSION_REFRESH_MIN_MS,
  MINI_APP_SESSION_TTL_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_SESSION_KEY_HEADER,
  MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS,
  MINI_APP_SESSION_ROTATE_AT_SEEN_IVS,
} = await import("../../packages/consts/miniAppCrypto");
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  clearPendingMiniAppSessionKey,
  commitMiniAppSessionAccess,
} = await import("../../packages/mini-app-api-server/auth/session");
const {
  purgeExpiredAuthSessions,
} = await import("../../packages/mini-app-api-server/auth/sessionLookup");
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const {
  sealMiniAppQuery,
  unsealRotatedSessionKey: frontendUnsealRotatedSessionKey,
} = await import("../../packages/mini-app-frontend/libs/crypto");
const {
  dispatchRawMiniAppTestRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");

/**
 * 构造当前时刻签名的超级管理员 `initData`。
 * @returns 已签名的 `initData` 查询字符串。
 */
function adminInitData(): string {
  return buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1_000),
    user: {
      id: SUPER_ADMIN_USER_ID,
      first_name: "SuperAdmin",
      username: "super_admin",
    },
  });
}

/**
 * 为指定会话的 `seenRequestIvs` 补齐占位 IV 至目标条目数。
 * @param session 目标会话记录。
 * @param targetSize 期望填充后的集合大小。
 * @param prefix 占位 IV 前缀。
 */
function fillSeenRequestIvs(
  session: Readonly<MiniAppAuthSession>,
  targetSize: number,
  prefix: string
): void {
  for (let i: number = session.seenRequestIvs.size; i < targetSize; i += 1) {
    session.seenRequestIvs.add(`${prefix}-${i}`);
  }
}

/**
 * 构造发送至 `POST /api/totp/setup` 的单 IV 加密空对象请求。
 * @param sessionToken 会话令牌。
 * @param cryptoKey 对应的 AES-256-GCM 密钥句柄。
 * @returns 可直接投递的 `Request`。
 */
async function buildEncryptedTotpSetupRequest(
  sessionToken: string,
  cryptoKey: CryptoKey
): Promise<Request> {
  const envelope: Readonly<MiniAppEncryptedEnvelope> =
    await encryptMiniAppEnvelope(
      cryptoKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
  return new Request("http://127.0.0.1:3000/api/totp/setup", {
    method: "POST",
    headers: {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: sessionToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(envelope),
  });
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppGalleryDownloadTickets.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppTotpRecordHolder.current = undefined;
  setSystemTime();
});

describe("Mini App AES-256-GCM IV 水位主动轮换与硬上限防护", () => {
  test("未到 nextRefreshAt 但达 IV 水位时立即主动轮换密钥、重置 IV 集合与冷却间隔，且保留旧纪元并发余量", async () => {
    expect(MINI_APP_SESSION_ROTATE_AT_SEEN_IVS).toBeGreaterThan(0);
    expect(MINI_APP_SESSION_ROTATE_AT_SEEN_IVS).toBeLessThan(
      MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS
    );

    const baseMs: number = 1_786_500_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const login: MiniAppLoginSuccessResponse = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const oldKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const initialSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(login.sessionToken)!;

    // 1. 仍在最短冷却期 5s 内（+1s）且未达水位（差 1 条）：绝不触发轮换。
    const preWatermarkMs: number = baseMs + 1_000;
    expect(preWatermarkMs).toBeLessThan(initialSession.nextRefreshAt);
    setSystemTime(new Date(preWatermarkMs));
    fillSeenRequestIvs(
      initialSession,
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS - 2,
      "pre-watermark"
    );

    const belowRes: Response = await dispatchRawMiniAppTestRequest(
      await buildEncryptedTotpSetupRequest(login.sessionToken, oldKey)
    );
    expect(belowRes.status).toBe(200);
    expect(belowRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(belowRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    expect(miniAppAuthSessions.get(login.sessionToken)?.seenRequestIvs.size).toBe(
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS - 1
    );

    // 2. 下一条加密请求将 seenRequestIvs.size 推至水位（仍在最短 5s 冷却期内，+2s）：
    // 立即主动轮换令牌与密钥、清空新纪元 IV 集合，并从当前时刻重新采样 [5s, 5min] 随机冷却。
    const rotateMs: number = baseMs + 2_000;
    expect(rotateMs).toBeLessThan(initialSession.nextRefreshAt);
    setSystemTime(new Date(rotateMs));
    const rotateRes: Response = await dispatchRawMiniAppTestRequest(
      await buildEncryptedTotpSetupRequest(login.sessionToken, oldKey)
    );
    expect(rotateRes.status).toBe(200);

    const newToken: string | null = rotateRes.headers.get(MINI_APP_SESSION_HEADER);
    const sealedNewKey: string | null = rotateRes.headers.get(
      MINI_APP_SESSION_KEY_HEADER
    );
    const refreshedExpiresAt: number = Number(
      rotateRes.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER)
    );
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(login.sessionToken);
    expect(sealedNewKey).not.toBeNull();
    expect(refreshedExpiresAt).toBe(rotateMs + MINI_APP_SESSION_TTL_MS);

    // 响应体仍使用本次请求匹配的旧密钥加密，新密钥可按新令牌 AAD 正常解封。
    const rotateEnvelope: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(await rotateRes.json());
    expect(rotateEnvelope).not.toBeNull();
    expect(
      await decryptMiniAppText({
        cryptoKey: oldKey,
        encrypted: rotateEnvelope!,
        additionalData: buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "res"),
      })
    ).not.toBeNull();
    const unsealedKeyHex: string | null = await frontendUnsealRotatedSessionKey(
      oldKey,
      sealedNewKey!,
      newToken!
    );
    expect(unsealedKeyHex).not.toBeNull();
    const newKey: CryptoKey = await importMiniAppAesGcmKey(unsealedKeyHex!);

    const rotatedSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(newToken!)!;
    expect(rotatedSession.seenRequestIvs.size).toBe(0);
    expect(rotatedSession.previousToken).toBe(login.sessionToken);
    expect(rotatedSession.previousSeenRequestIvs?.size).toBe(
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS
    );
    expect(rotatedSession.createdAt).toBe(rotateMs);
    const resampledDelayMs: number =
      rotatedSession.nextRefreshAt - rotatedSession.createdAt;
    expect(resampledDelayMs).toBeGreaterThanOrEqual(MINI_APP_SESSION_REFRESH_MIN_MS);
    expect(resampledDelayMs).toBeLessThanOrEqual(MINI_APP_SESSION_REFRESH_MAX_MS);

    // 3. 轮换后并发在途旧令牌请求在旧纪元余量内（3,072 -> 4,096）照常放行，
    // 不再次轮换并原样重新附带同一新令牌与轮换密文。
    const inFlightOldRes: Response = await dispatchRawMiniAppTestRequest(
      await buildEncryptedTotpSetupRequest(login.sessionToken, oldKey)
    );
    expect(inFlightOldRes.status).toBe(200);
    expect(inFlightOldRes.headers.get(MINI_APP_SESSION_HEADER)).toBe(newToken);
    expect(inFlightOldRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBe(
      sealedNewKey
    );
    expect(miniAppAuthSessions.get(newToken!)?.previousSeenRequestIvs?.size).toBe(
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS + 1
    );

    // 4. 客户端切换至新令牌与新密钥提交首个请求：立即作废旧纪元 IV 集合且在重置后的冷却期内不重复轮换。
    setSystemTime(new Date(rotateMs + 1_000));
    const confirmRes: Response = await dispatchRawMiniAppTestRequest(
      await buildEncryptedTotpSetupRequest(newToken!, newKey)
    );
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(confirmRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    const confirmedSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(newToken!)!;
    expect(confirmedSession.previousToken).toBeUndefined();
    expect(confirmedSession.previousSeenRequestIvs).toBeUndefined();
    expect(confirmedSession.seenRequestIvs.size).toBe(1);
  });

  test("非轮换二进制路由达水位不轮换、下一条加密响应路由立即轮换恢复，且超硬上限仍吊销；400 失败解密不触发轮换", async () => {
    const baseMs: number = 1_786_600_000_000;
    setSystemTime(new Date(baseMs));
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    mkdirSync(galleryDir, { recursive: true });
    const fileName: string = "iv-watermark-sample.png";
    await Bun.write(
      join(galleryDir, fileName),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

    const password: string = getBotMiniAppConfig()!.password;
    const login: MiniAppLoginSuccessResponse = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const session: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(login.sessionToken)!;

    // 1. 推进至水位前 1 条并通过 encryptResponse: false 的 /api/gallery/file 跨过水位：
    // 二进制图片流不轮换会话密钥，且在硬上限余量内继续放行。
    setSystemTime(new Date(baseMs + 1_000));
    fillSeenRequestIvs(
      session,
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS - 1,
      "gallery-file"
    );
    const sealedFileQuery: string = await sealMiniAppQuery(
      cryptoKey,
      `fileName=${fileName}`,
      "GET /api/gallery/file"
    );
    const galleryFileRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedFileQuery)}`,
        {
          method: "GET",
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: login.sessionToken,
          },
        }
      )
    );
    expect(galleryFileRes.status).toBe(200);
    expect(galleryFileRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(galleryFileRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    expect(session.seenRequestIvs.size).toBe(MINI_APP_SESSION_ROTATE_AT_SEEN_IVS);

    // 2. 在已达水位状态下发送畸形加密信封（400 INVALID_ENCRYPTED_PAYLOAD）：绝不触发轮换。
    const badRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: login.sessionToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ encrypted: true, iv: "bad", payload: "bad" }),
      })
    );
    expect(badRes.status).toBe(400);
    expect(badRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(badRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    const badEnvelope: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(await badRes.json());
    const badBodyText: string | null = await decryptMiniAppText({
      cryptoKey,
      encrypted: badEnvelope!,
      additionalData: buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "res"),
    });
    expect(JSON.parse(badBodyText!)).toEqual({
      error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
    });

    // 3. 即使已填满至硬上限，零 IV 的 encryptResponse: true 路由（GET /api/status）仍可立即触发轮换救活会话。
    fillSeenRequestIvs(session, MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS, "full-cap");
    const recoverRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        method: "GET",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: login.sessionToken,
        },
      })
    );
    expect(recoverRes.status).toBe(200);
    const recoveredToken: string | null = recoverRes.headers.get(
      MINI_APP_SESSION_HEADER
    );
    expect(recoveredToken).not.toBeNull();
    expect(recoveredToken).not.toBe(login.sessionToken);
    expect(miniAppAuthSessions.get(recoveredToken!)?.seenRequestIvs.size).toBe(0);

    // 4. 新会话若持续跳过轮换直到已达硬上限，再提交携带 IV 的加密请求仍直接 401 SESSION_EXPIRED 并吊销会话。
    const secondLogin: MiniAppLoginSuccessResponse = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const secondKey: CryptoKey = await importMiniAppAesGcmKey(secondLogin.sessionKey);
    const secondSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(secondLogin.sessionToken)!;
    fillSeenRequestIvs(
      secondSession,
      MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS,
      "hard-cap"
    );
    const overflowSealedQuery: string = await sealMiniAppQuery(
      secondKey,
      `fileName=${fileName}`,
      "GET /api/gallery/file"
    );
    const overflowRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(overflowSealedQuery)}`,
        {
          method: "GET",
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: secondLogin.sessionToken,
          },
        }
      )
    );
    expect(overflowRes.status).toBe(401);
    expect(((await overflowRes.json()) as { readonly error: string }).error).toBe(
      "SESSION_EXPIRED"
    );
    expect(miniAppAuthSessions.has(secondLogin.sessionToken)).toBeFalse();
  });

  test("接近 2 小时绝对寿命上限时由 IV 水位触发的轮换仍严守 absoluteExpiresAt 封顶", async () => {
    const baseMs: number = 1_786_700_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const login: MiniAppLoginSuccessResponse = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const absoluteExpiresAt: number = baseMs + MINI_APP_SESSION_MAX_LIFETIME_MS;
    let currentToken: string = login.sessionToken;
    let currentKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);

    // 沿 45 分钟滑动窗分两步推进至距离 2 小时绝对上限仅剩 10 分钟，并获得新的 nextRefreshAt（位于 nearEndMs + [5s, 5min]）。
    const checkpoints: readonly number[] = [
      baseMs + MINI_APP_SESSION_TTL_MS - 5 * 60_000,
      baseMs + 2 * (MINI_APP_SESSION_TTL_MS - 5 * 60_000),
      absoluteExpiresAt - 10 * 60_000,
    ];
    for (const checkpointMs of checkpoints) {
      setSystemTime(new Date(checkpointMs));
      const stepRotateRes: Response = await dispatchRawMiniAppTestRequest(
        await buildEncryptedTotpSetupRequest(currentToken, currentKey)
      );
      expect(stepRotateRes.status).toBe(200);
      const nextToken: string = stepRotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
      const nextKeyHex: string = (await frontendUnsealRotatedSessionKey(
        currentKey,
        stepRotateRes.headers.get(MINI_APP_SESSION_KEY_HEADER)!,
        nextToken
      ))!;
      currentToken = nextToken;
      currentKey = await importMiniAppAesGcmKey(nextKeyHex);
    }

    const nearEndMs: number = checkpoints[checkpoints.length - 1]!;

    // 在冷却期内（+1s）通过 IV 水位触发主动轮换：expiresAt 必须被锁在 absoluteExpiresAt，不得突破 2 小时封顶。
    const watermarkNearEndMs: number = nearEndMs + 1_000;
    setSystemTime(new Date(watermarkNearEndMs));
    const lateSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(currentToken)!;
    expect(watermarkNearEndMs).toBeLessThan(lateSession.nextRefreshAt);
    fillSeenRequestIvs(
      lateSession,
      MINI_APP_SESSION_ROTATE_AT_SEEN_IVS - 1,
      "late-watermark"
    );
    const watermarkRotateRes: Response = await dispatchRawMiniAppTestRequest(
      await buildEncryptedTotpSetupRequest(currentToken, currentKey)
    );
    expect(watermarkRotateRes.status).toBe(200);
    const finalToken: string | null = watermarkRotateRes.headers.get(
      MINI_APP_SESSION_HEADER
    );
    expect(finalToken).not.toBeNull();
    expect(finalToken).not.toBe(currentToken);
    expect(
      Number(watermarkRotateRes.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER))
    ).toBe(absoluteExpiresAt);
    expect(miniAppAuthSessions.get(finalToken!)?.expiresAt).toBe(absoluteExpiresAt);
    expect(miniAppAuthSessions.get(finalToken!)?.seenRequestIvs.size).toBe(0);
  });

  test("会话清理水位在无到期事件时跳过全表扫描，并在宽限期截止与清空表时准确更新", () => {
    const baseMs: number = 1_786_800_000_000;
    miniAppAuthSessions.clear();
    purgeExpiredAuthSessions(baseMs);
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(Number.POSITIVE_INFINITY);

    const issued: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(
      baseMs + MINI_APP_SESSION_PREVIOUS_GRACE_MS + 1
    );
    clearPendingMiniAppSessionKey(issued.token);
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(issued.expiresAt);

    // 旋转会话后，水位应收紧到旧令牌并发宽限期截止时刻（createdAt + GRACE + 1）。
    const rotateMs: number = issued.nextRefreshAt + 1;
    const commitResult = commitMiniAppSessionAccess({
      session: issued,
      requestToken: issued.token,
      matchedViaPrevious: false,
      allowRotation: true,
      nowMs: rotateMs,
    });
    expect(commitResult.ok).toBeTrue();
    if (!commitResult.ok || !commitResult.rotated) {
      throw new Error("Expected session rotation.");
    }
    const rotated: Readonly<MiniAppAuthSession> = commitResult.session;
    const graceDeadline: number =
      rotated.createdAt + MINI_APP_SESSION_PREVIOUS_GRACE_MS + 1;
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(graceDeadline);

    // 水位之前调用 purgeExpiredAuthSessions 应 O(1) 短路，不遍历 miniAppAuthSessions。
    const forEachSpy = spyOn(miniAppAuthSessions, "forEach");
    try {
      purgeExpiredAuthSessions(graceDeadline - 1);
      expect(forEachSpy).not.toHaveBeenCalled();

      // 到达宽限期截止时刻触发扫描，清理 previousToken 并将水位推进至会话到期时刻。
      purgeExpiredAuthSessions(graceDeadline);
      expect(forEachSpy).toHaveBeenCalledTimes(1);
    } finally {
      forEachSpy.mockRestore();
    }

    const afterGrace: Readonly<MiniAppAuthSession> | undefined =
      miniAppAuthSessions.get(rotated.token);
    expect(afterGrace).toBeDefined();
    expect(afterGrace?.previousToken).toBeUndefined();
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(afterGrace!.expiresAt);

    // 外部直接 clear() 后再次调用清理，水位自动重置回 Infinity。
    miniAppAuthSessions.clear();
    purgeExpiredAuthSessions(graceDeadline + 10);
    expect(miniAppAuthSessionWatermark.nextPurgeAt).toBe(Number.POSITIVE_INFINITY);
  });
});
