/**
 * Mini App 加密信封 AAD 绑定、无正文写请求拒空、IV 防重放与上限吊销、
 * 失败解密只读会话保护（不清空 `previousToken` / 不触发轮换）、`[5s, 5min]` 随机轮换与独立 5min 宽限期，以及 2 小时会话总寿命封顶专项测试。
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { imageFixture } from "../helpers/image";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const {
  identityEntryCounts,
  resetIdentityStorageCache,
  unacknowledgedWhitelistWrites,
} = await import("../../packages/cache/main/identityStorage");
const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const { RANDOM_IMAGE_MAX_BYTES } = await import("../../packages/consts/imageGallery");
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
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_DOWNLOAD_TICKET_TTL_MS,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_SESSION_KEY_HEADER,
  MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS,
} = await import("../../packages/consts/miniAppCrypto");
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const {
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { revokeMiniAppAuthSession } = await import(
  "../../packages/mini-app-api-server/auth/session"
);
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const {
  dispatchRawMiniAppTestRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");
const {
  encryptMiniAppBinary,
  unsealRotatedSessionKey: frontendUnsealRotatedSessionKey,
} = await import("../../packages/mini-app-frontend/libs/crypto");
import type { MiniAppLoginSuccessResponse } from "../../packages/types/miniApp/auth";
import type { MiniAppEncryptedEnvelope } from "../../packages/types/miniApp/configs";
import type { MiniAppGalleryUploadResult } from "../../packages/types/miniApp/gallery";

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

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
  resetChatStateCache();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppTotpRecordHolder.current = undefined;
  setSystemTime();
});

describe("Mini App AAD 方向绑定、IV 防重放、两阶段会话提交与 2 小时封顶", () => {
  test("信封 AAD 方向/路径/方法隔离、无正文 POST/DELETE 禁止 0 字节、IV 重放/上限拦截与失败解密前会话只读保护", async () => {
    const baseMs: number = 1_786_000_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const completedLogin = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password },
    });
    const loginBody: MiniAppLoginSuccessResponse =
      completedLogin.payload as unknown as MiniAppLoginSuccessResponse;
    expect(miniAppAuthSessions.get(loginBody.sessionToken)?.pendingSessionKey).toBeUndefined();
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(loginBody.sessionKey);
    const headers: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: loginBody.sessionToken,
      "Content-Type": "application/json",
    };

    // 1. 信封 AAD 绑定：拿 :res AAD 或跨路由 :req AAD 的密文提交 POST 一律 400 拒绝。
    const crossRouteEnv = await encryptMiniAppEnvelope(
      cryptoKey,
      JSON.stringify({ id: 500_401, enabled: true }),
      buildMiniAppEnvelopeAad("POST", "/api/identities/blocklist", "req")
    );
    expect(
      (
        await dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/identities/whitelist", {
            method: "POST",
            headers,
            body: JSON.stringify(crossRouteEnv),
          })
        )
      ).status
    ).toBe(400);

    const responseAadOnRequest = await encryptMiniAppEnvelope(
      cryptoKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "res")
    );
    expect(
      (
        await dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/totp/setup", {
            method: "POST",
            headers,
            body: JSON.stringify(responseAadOnRequest),
          })
        )
      ).status
    ).toBe(400);

    // 2. 加密 POST/DELETE 路线严格拒绝 0 字节空正文；携带加密 "{}" 成功。
    for (const [method, path] of [
      ["POST", "/api/totp/setup"],
      ["POST", "/api/mood/switch"],
      ["DELETE", "/api/totp"],
    ] as const) {
      const emptyRes: Response = await dispatchRawMiniAppTestRequest(
        new Request(`http://127.0.0.1:3000${path}`, {
          method,
          headers,
        })
      );
      expect(emptyRes.status).toBe(400);
    }

    const validSetupEnv = await encryptMiniAppEnvelope(
      cryptoKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
    const okSetupRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers,
        body: JSON.stringify(validSetupEnv),
      })
    );
    expect(okSetupRes.status).toBe(200);

    // 3. 同一密钥纪元重放相同信封 IV 或查询 IV 被拒绝；超过 MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS 硬上限返回 401 SESSION_EXPIRED 并吊销会话。
    const replayedPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers,
        body: JSON.stringify(validSetupEnv),
      })
    );
    expect(replayedPostRes.status).toBe(400);

    const sessionRecord = miniAppAuthSessions.get(loginBody.sessionToken)!;
    for (let i: number = sessionRecord.seenRequestIvs.size; i < MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS; i += 1) {
      sessionRecord.seenRequestIvs.add(`filled-iv-${i}`);
    }
    const cappedEnv = await encryptMiniAppEnvelope(
      cryptoKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
    const capExceededRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers,
        body: JSON.stringify(cappedEnv),
      })
    );
    expect(capExceededRes.status).toBe(401);
    expect(((await capExceededRes.json()) as { readonly error: string }).error).toBe(
      "SESSION_EXPIRED"
    );
    expect(miniAppAuthSessions.has(loginBody.sessionToken)).toBeFalse();

    // 4. 解密失败绝不轮换会话或清除 previousToken，也不在响应头下发新令牌。
    const freshLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const overdueMs: number = baseMs + MINI_APP_SESSION_REFRESH_MAX_MS + 2_000;
    setSystemTime(new Date(overdueMs));
    const overdueHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: freshLogin.sessionToken,
      "Content-Type": "application/json",
    };
    const failedOverduePostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: overdueHeaders,
        body: JSON.stringify({ encrypted: true, iv: "bad", payload: "bad" }),
      })
    );
    expect(failedOverduePostRes.status).toBe(400);
    expect(failedOverduePostRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(failedOverduePostRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    expect(miniAppAuthSessions.has(freshLogin.sessionToken)).toBeTrue();

    // 真正触发一次成功旋转后，用携带新令牌的坏请求测试 previousToken 不被提前清除。
    const triggerRotateRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: freshLogin.sessionToken,
        },
      })
    );
    expect(triggerRotateRes.status).toBe(200);
    const rotatedToken: string = triggerRotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(rotatedToken).not.toBe(freshLogin.sessionToken);
    expect(miniAppAuthSessions.get(rotatedToken)?.pendingSessionKey).toBeUndefined();
    const badConfirmWithNewTokenRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: rotatedToken,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    );
    expect(badConfirmWithNewTokenRes.status).toBe(400);
    expect(miniAppAuthSessions.get(rotatedToken)?.previousToken).toBe(
      freshLogin.sessionToken
    );

    // 5. 滑动续期受 2 小时绝对总寿命上限约束，且 initData 在 2h+45m 后不再被活跃会话豁免。
    let curMs: number = overdueMs;
    const cappedStartLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    let slidingToken: string = cappedStartLogin.sessionToken;
    for (let step: number = 0; step < 120; step += 1) {
      curMs += MINI_APP_SESSION_REFRESH_MAX_MS + 1_000;
      if (curMs >= overdueMs + MINI_APP_SESSION_MAX_LIFETIME_MS - 1_000) {
        break;
      }
      setSystemTime(new Date(curMs));
      const hopRes: Response = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: slidingToken,
          },
        })
      );
      expect(hopRes.status).toBe(200);
      const nextTok: string | null = hopRes.headers.get(MINI_APP_SESSION_HEADER);
      if (nextTok !== null) {
        slidingToken = nextTok;
      }
      const nextExp: number = Number(
        hopRes.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER) ??
          miniAppAuthSessions.get(slidingToken)?.expiresAt
      );
      expect(nextExp).toBeLessThanOrEqual(
        overdueMs + MINI_APP_SESSION_MAX_LIFETIME_MS
      );
    }

    setSystemTime(new Date(overdueMs + MINI_APP_SESSION_MAX_LIFETIME_MS + 1_000));
    const after2hRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: slidingToken,
        },
      })
    );
    expect(after2hRes.status).toBe(401);

    // 确认 initData 超出 2h + 45m 后即便会话刚创建也会被拒
    const agedAuthLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const tooOldInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate:
        Math.floor(Date.now() / 1_000) -
        Math.floor((MINI_APP_SESSION_MAX_LIFETIME_MS + MINI_APP_SESSION_TTL_MS) / 1_000) -
        5,
      user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
    });
    const staleInitDataRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: tooOldInitData,
          [MINI_APP_SESSION_HEADER]: agedAuthLogin.sessionToken,
        },
      })
    );
    expect(staleInitDataRes.status).toBe(401);
    expect(MINI_APP_DOWNLOAD_TICKET_TTL_MS).toBeGreaterThan(0);
  });

  test("POST /api/gallery/upload 强制校验 sessionKey：拒绝裸二进制/截断/错密钥/错AAD/篡改/重放，仅接受合法加密二进制帧", async () => {
    const baseMs: number = 1_787_000_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    rmSync(galleryDir, { recursive: true, force: true });
    mkdirSync(galleryDir, { recursive: true });

    const login = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const wrongKey: CryptoKey = await importMiniAppAesGcmKey("f".repeat(64));
    const uploadReqAad: Uint8Array<ArrayBuffer> = buildMiniAppEnvelopeAad(
      "POST",
      "/api/gallery/upload",
      "req"
    );
    const uploadResAad: Uint8Array<ArrayBuffer> = buildMiniAppEnvelopeAad(
      "POST",
      "/api/gallery/upload",
      "res"
    );
    const validPng: Uint8Array = await new Bun.Image(imageFixture(8, 8)).png().bytes();

    const decryptUploadJson = async (
      res: Response,
      key: CryptoKey = cryptoKey
    ): Promise<Record<string, unknown>> => {
      const env: Readonly<MiniAppEncryptedEnvelope> | null =
        parseMiniAppEncryptedEnvelope(await res.json());
      expect(env).not.toBeNull();
      const plain: string | null = await decryptMiniAppText({
        cryptoKey: key,
        encrypted: env!,
        additionalData: uploadResAad,
      });
      expect(plain).not.toBeNull();
      return JSON.parse(plain!) as Record<string, unknown>;
    };

    // 将时钟推过最长轮换阈值，顺便验证校验失败的上传不触发轮换、不清除会话。
    setSystemTime(new Date(baseMs + MINI_APP_SESSION_REFRESH_MAX_MS + 1_000));
    const overdueHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: login.sessionToken,
      "Content-Type": "application/octet-stream",
    };

    const validFrame: Uint8Array<ArrayBuffer> = await encryptMiniAppBinary(
      cryptoKey,
      validPng,
      uploadReqAad
    );
    const tamperedMid: Uint8Array = new Uint8Array(validFrame);
    tamperedMid[validFrame.byteLength - 1] =
      (tamperedMid[validFrame.byteLength - 1] ?? 0) ^ 0xff;

    const badUploadRequests: readonly (readonly [string, Uint8Array | undefined])[] = [
      // 原始未加密 PNG 字节、0 字节裸请求、< 28B 截断帧
      ["/api/gallery/upload", validPng],
      ["/api/gallery/upload", undefined],
      ["/api/gallery/upload", new Uint8Array(0)],
      [
        "/api/gallery/upload",
        validFrame.subarray(
          0,
          MINI_APP_AES_GCM_IV_BYTES + MINI_APP_AES_GCM_TAG_BITS / 8 - 1
        ),
      ],
      // 错密钥、错 AAD、篡改尾字节认证标签、普通 JSON 信封格式误用
      ["/api/gallery/upload", await encryptMiniAppBinary(wrongKey, validPng, uploadReqAad)],
      [
        "/api/gallery/upload",
        await encryptMiniAppBinary(
          cryptoKey,
          validPng,
          buildMiniAppEnvelopeAad("POST", "/api/gallery/delete", "req")
        ),
      ],
      ["/api/gallery/upload", tamperedMid],
      [
        "/api/gallery/upload",
        new TextEncoder().encode(
          JSON.stringify(await encryptMiniAppEnvelope(cryptoKey, "{}", uploadReqAad))
        ),
      ],
      // 合法加密帧但附带裸 `?` 或明文查询参数
      ["/api/gallery/upload?", validFrame],
      ["/api/gallery/upload?fileName=a.png", validFrame],
    ];

    for (const [path, body] of badUploadRequests) {
      const res: Response = await dispatchRawMiniAppTestRequest(
        new Request(`http://127.0.0.1:3000${path}`, {
          method: "POST",
          headers: overdueHeaders,
          body,
        })
      );
      expect(res.status).toBe(400);
      expect(res.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
      expect(res.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
      expect(await decryptUploadJson(res)).toEqual({
        error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
      });
    }
    // 没有任何合法字节写入图库目录，且原会话仍未轮换、未消耗 IV 配额。
    expect(readdirSync(galleryDir)).toEqual([]);
    expect(miniAppAuthSessions.get(login.sessionToken)?.seenRequestIvs.size).toBe(0);

    // 确认已轮换会话遇到失败的未加密上传请求时，绝不提前抹除 previousToken。
    const rotateTriggerRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: login.sessionToken,
        },
      })
    );
    expect(rotateTriggerRes.status).toBe(200);
    const rotatedToken: string = rotateTriggerRes.headers.get(MINI_APP_SESSION_HEADER)!;
    const rawWithNewTokenRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: rotatedToken,
          "Content-Type": "application/octet-stream",
        },
        body: validPng,
      })
    );
    expect(rawWithNewTokenRes.status).toBe(400);
    expect(miniAppAuthSessions.get(rotatedToken)?.previousToken).toBe(
      login.sessionToken
    );

    // 新登录一把干净会话验证合法加密上传：0B -> empty，>10MiB -> tooLarge，PNG -> added，同 IV 重放 -> 400。
    const freshLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const freshKey: CryptoKey = await importMiniAppAesGcmKey(freshLogin.sessionKey);
    const freshHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: freshLogin.sessionToken,
      "Content-Type": "application/octet-stream",
    };

    const encryptedEmptyRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: freshHeaders,
        body: await encryptMiniAppBinary(freshKey, new Uint8Array(0), uploadReqAad),
      })
    );
    expect(encryptedEmptyRes.status).toBe(400);
    expect((await decryptUploadJson(encryptedEmptyRes, freshKey)).outcome).toBe("empty");

    const encryptedOversizedRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: freshHeaders,
        body: await encryptMiniAppBinary(
          freshKey,
          new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1),
          uploadReqAad
        ),
      })
    );
    expect(encryptedOversizedRes.status).toBe(400);
    expect((await decryptUploadJson(encryptedOversizedRes, freshKey)).outcome).toBe(
      "tooLarge"
    );

    const encryptedValidFrame: Uint8Array<ArrayBuffer> = await encryptMiniAppBinary(
      freshKey,
      validPng,
      uploadReqAad
    );
    const validUploadRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: freshHeaders,
        body: encryptedValidFrame,
      })
    );
    expect(validUploadRes.status).toBe(200);
    const uploadResult = (await decryptUploadJson(
      validUploadRes,
      freshKey
    )) as unknown as MiniAppGalleryUploadResult;
    expect(uploadResult.ok).toBeTrue();
    expect(uploadResult.outcome).toBe("added");

    // 重放同一加密二进制帧（同 IV）必须返回 400 INVALID_ENCRYPTED_PAYLOAD。
    const replayedUploadRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: freshHeaders,
        body: encryptedValidFrame,
      })
    );
    expect(replayedUploadRes.status).toBe(400);
    expect(await decryptUploadJson(replayedUploadRes, freshKey)).toEqual({
      error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
    });

    // IV 记录数达到 MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS 硬上限后，继续加密上传返回 401 SESSION_EXPIRED 并吊销会话。
    const freshSessionRecord = miniAppAuthSessions.get(freshLogin.sessionToken)!;
    for (
      let i: number = freshSessionRecord.seenRequestIvs.size;
      i < MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS;
      i += 1
    ) {
      freshSessionRecord.seenRequestIvs.add(`upload-iv-${i}`);
    }
    const cappedUploadRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: freshHeaders,
        body: await encryptMiniAppBinary(freshKey, validPng, uploadReqAad),
      })
    );
    expect(cappedUploadRes.status).toBe(401);
    expect(((await cappedUploadRes.json()) as { readonly error: string }).error).toBe(
      "SESSION_EXPIRED"
    );
    expect(miniAppAuthSessions.has(freshLogin.sessionToken)).toBeFalse();
  });

  test("并发携带同一 IV 的加密请求与异步解密窗口内会话吊销均受提交阶段原子防护（防 TOCTOU）", async () => {
    const baseMs: number = 1_786_100_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const login = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const sharedEnvelope = await encryptMiniAppEnvelope(
      cryptoKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
    const requestHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: login.sessionToken,
      "Content-Type": "application/json",
    };

    // 1. 两个并发请求携带完全相同的加密 IV，同时通过前置只读检查并阻塞在异步 crypto.subtle.decrypt：
    // 提交阶段仅放行先到达者，后者必须命中同步 IV 查重并返回 400 INVALID_ENCRYPTED_PAYLOAD。
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let enteredCount: number = 0;
    let releaseBarrier!: () => void;
    const barrier: Promise<void> = new Promise<void>((resolve: () => void): void => {
      releaseBarrier = resolve;
    });
    const concurrentSpy = spyOn(crypto.subtle, "decrypt").mockImplementation(
      async (...args: Parameters<SubtleCrypto["decrypt"]>): Promise<ArrayBuffer> => {
        enteredCount += 1;
        if (enteredCount >= 2) {
          releaseBarrier();
        } else {
          await barrier;
        }
        return originalDecrypt(...args);
      }
    );
    let resA: Response;
    let resB: Response;
    try {
      const settled = await Promise.allSettled([
        dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/totp/setup", {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(sharedEnvelope),
          })
        ),
        dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/totp/setup", {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(sharedEnvelope),
          })
        ),
      ]);
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled[1]?.status).toBe("fulfilled");
      if (settled[0]?.status !== "fulfilled" || settled[1]?.status !== "fulfilled") {
        throw new Error("Expected both concurrent TOCTOU requests to settle.");
      }
      resA = settled[0].value;
      resB = settled[1].value;
    } finally {
      concurrentSpy.mockRestore();
    }

    const sortedStatuses: number[] = [resA.status, resB.status].sort(
      (a: number, b: number): number => a - b
    );
    expect(sortedStatuses).toEqual([200, 400]);
    const rejectedResponse: Response = resA.status === 400 ? resA : resB;
    const rejectedEnvelope = parseMiniAppEncryptedEnvelope(await rejectedResponse.json())!;
    const rejectedPlain: string | null = await decryptMiniAppText({
      cryptoKey,
      encrypted: rejectedEnvelope,
      additionalData: buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "res"),
    });
    expect(JSON.parse(rejectedPlain!)).toEqual({
      error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
    });
    expect(miniAppAuthSessions.get(login.sessionToken)?.seenRequestIvs.size).toBe(1);

    // 2. 异步解密进行期间若会话被登出/锁定吊销，提交阶段必须拦截并返回 401 SESSION_EXPIRED，严禁执行下游业务写入。
    const revokeLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const revokeKey: CryptoKey = await importMiniAppAesGcmKey(revokeLogin.sessionKey);
    const whitelistEnvelope = await encryptMiniAppEnvelope(
      revokeKey,
      JSON.stringify({ id: 500_888, enabled: true }),
      buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
    );
    const baselineWhitelistCount: number = identityEntryCounts.whitelist;
    const revokeSpy = spyOn(crypto.subtle, "decrypt").mockImplementationOnce(
      async (...args: Parameters<SubtleCrypto["decrypt"]>): Promise<ArrayBuffer> => {
        const decrypted: ArrayBuffer = await originalDecrypt(...args);
        revokeMiniAppAuthSession(revokeLogin.sessionToken);
        return decrypted;
      }
    );
    let revokedRes: Response;
    try {
      revokedRes = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/identities/whitelist", {
          method: "POST",
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: revokeLogin.sessionToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(whitelistEnvelope),
        })
      );
    } finally {
      revokeSpy.mockRestore();
    }

    expect(revokedRes.status).toBe(401);
    expect(((await revokedRes.json()) as { readonly error: string }).error).toBe(
      "SESSION_EXPIRED"
    );
    expect(miniAppAuthSessions.has(revokeLogin.sessionToken)).toBeFalse();
    expect(identityEntryCounts.whitelist).toBe(baselineWhitelistCount);
    expect(unacknowledgedWhitelistWrites.has(500_888)).toBeFalse();
  });

  test("随机 [5s, 5min] 轮换阈值、45min 窗口内超时续期、独立 5min 旧密钥宽限期与 2 小时总寿命", async () => {
    const baseMs: number = 1_786_200_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;

    // 1. 验证自然登录会话的 nextRefreshAt 在 [5s, 5min] 闭区间、总寿命为 2 小时，且 5s 前（+4_999ms）绝不触发轮换。
    const naturalLogin = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const naturalSession = miniAppAuthSessions.get(naturalLogin.sessionToken)!;
    const initialRefreshDelayMs: number =
      naturalSession.nextRefreshAt - naturalSession.createdAt;
    expect(initialRefreshDelayMs).toBeGreaterThanOrEqual(
      MINI_APP_SESSION_REFRESH_MIN_MS
    );
    expect(initialRefreshDelayMs).toBeLessThanOrEqual(
      MINI_APP_SESSION_REFRESH_MAX_MS
    );
    expect(naturalSession.absoluteExpiresAt - naturalSession.issuedAt).toBe(
      MINI_APP_SESSION_MAX_LIFETIME_MS
    );

    setSystemTime(new Date(baseMs + MINI_APP_SESSION_REFRESH_MIN_MS - 1));
    const beforeMinRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: naturalLogin.sessionToken,
        },
      })
    );
    expect(beforeMinRes.status).toBe(200);
    expect(beforeMinRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();

    // 2. 通过定向控制 Uint32Array(1) RNG 为 0，验证最短 5s 边界精确命中、5s 轮换后旧密钥在独立 5min 宽限期仍有效并在首次新令牌请求时即时作废。
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    const minSampleSpy = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array && array.length === 1) {
          array[0] = 0;
          return array;
        }
        return originalGetRandomValues(array);
      }
    );
    let minBoundaryLogin: MiniAppLoginSuccessResponse;
    try {
      minBoundaryLogin = (
        await performMiniAppTestEcdhLogin({
          initData: adminInitData(),
          credentialPayload: { password },
        })
      ).payload as unknown as MiniAppLoginSuccessResponse;
    } finally {
      minSampleSpy.mockRestore();
    }
    const minSession = miniAppAuthSessions.get(minBoundaryLogin.sessionToken)!;
    expect(minSession.nextRefreshAt).toBe(
      minSession.createdAt + MINI_APP_SESSION_REFRESH_MIN_MS
    );

    setSystemTime(new Date(minSession.createdAt + MINI_APP_SESSION_REFRESH_MIN_MS - 1));
    const justBeforeMinRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: minBoundaryLogin.sessionToken,
        },
      })
    );
    expect(justBeforeMinRes.status).toBe(200);
    expect(justBeforeMinRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();

    const exactMinMs: number = minSession.createdAt + MINI_APP_SESSION_REFRESH_MIN_MS;
    setSystemTime(new Date(exactMinMs));
    const atMinRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: minBoundaryLogin.sessionToken,
        },
      })
    );
    expect(atMinRes.status).toBe(200);
    const tokenAfter5s: string | null = atMinRes.headers.get(MINI_APP_SESSION_HEADER);
    expect(tokenAfter5s).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokenAfter5s).not.toBe(minBoundaryLogin.sessionToken);
    const rotatedRecord = miniAppAuthSessions.get(tokenAfter5s!)!;
    const nextEpochDelayMs: number = rotatedRecord.nextRefreshAt - rotatedRecord.createdAt;
    expect(nextEpochDelayMs).toBeGreaterThanOrEqual(MINI_APP_SESSION_REFRESH_MIN_MS);
    expect(nextEpochDelayMs).toBeLessThanOrEqual(MINI_APP_SESSION_REFRESH_MAX_MS);

    // 推进至独立 5 分钟宽限期末尾（已远超下一代最短 5s / 最长 5min 轮换点），在首次确认新令牌前旧令牌仍可通行且只取回同一新令牌与轮换密文。
    setSystemTime(new Date(exactMinMs + MINI_APP_SESSION_PREVIOUS_GRACE_MS - 1_000));
    const inGraceOldTokenRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: minBoundaryLogin.sessionToken,
        },
      })
    );
    expect(inGraceOldTokenRes.status).toBe(200);
    expect(inGraceOldTokenRes.headers.get(MINI_APP_SESSION_HEADER)).toBe(tokenAfter5s);
    expect(inGraceOldTokenRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBe(
      atMinRes.headers.get(MINI_APP_SESSION_KEY_HEADER)
    );

    // 首次带新令牌成功提交后立即作废旧令牌；随后再携带旧令牌直接返回 401。
    const confirmNewTokenRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: tokenAfter5s!,
        },
      })
    );
    expect(confirmNewTokenRes.status).toBe(200);
    const activeAfterConfirm: string =
      confirmNewTokenRes.headers.get(MINI_APP_SESSION_HEADER) ?? tokenAfter5s!;
    expect(miniAppAuthSessions.get(activeAfterConfirm)?.previousToken).not.toBe(
      minBoundaryLogin.sessionToken
    );

    const invalidatedOldTokenRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: minBoundaryLogin.sessionToken,
        },
      })
    );
    expect(invalidatedOldTokenRes.status).toBe(401);

    // 3. 空闲 10 分钟（远超 5 分钟最长轮换上界、仍在 45 分钟窗口与 2 小时上限内），下一次加密请求仍可正常续期与轮换。
    const idleMs: number =
      exactMinMs + MINI_APP_SESSION_PREVIOUS_GRACE_MS + 10 * 60 * 1_000;
    setSystemTime(new Date(idleMs));
    const idleRenewRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: activeAfterConfirm,
        },
      })
    );
    expect(idleRenewRes.status).toBe(200);
    const tokenAfterIdle: string | null = idleRenewRes.headers.get(
      MINI_APP_SESSION_HEADER
    );
    expect(tokenAfterIdle).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokenAfterIdle).not.toBe(activeAfterConfirm);
    expect(Number(idleRenewRes.headers.get(MINI_APP_SESSION_EXPIRES_AT_HEADER))).toBe(
      Math.min(
        idleMs + MINI_APP_SESSION_TTL_MS,
        minSession.issuedAt + MINI_APP_SESSION_MAX_LIFETIME_MS
      )
    );
  });

  test("轮换响应丢失后旧令牌请求原样取回同一轮换密文并可解封切换；解密窗口内令牌被轮换并确认的在途请求按谱系提交且不轮换", async () => {
    const baseMs: number = 1_786_200_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const login = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const firstKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const statusRequest = (token: string): Request =>
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: token,
        },
      });

    // 1. 到达本代轮换点后的首个请求触发轮换；会话只保存经旧密钥封装的密文，不保存明文新密钥。该响应视为丢失。
    setSystemTime(new Date(miniAppAuthSessions.get(login.sessionToken)!.nextRefreshAt + 1));
    const lostRotationRes: Response = await dispatchRawMiniAppTestRequest(
      statusRequest(login.sessionToken)
    );
    expect(lostRotationRes.status).toBe(200);
    const secondToken: string = lostRotationRes.headers.get(MINI_APP_SESSION_HEADER)!;
    const sealedHeader: string = lostRotationRes.headers.get(MINI_APP_SESSION_KEY_HEADER)!;
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(miniAppAuthSessions.get(secondToken)?.pendingSessionKey).toBeUndefined();
    expect(miniAppAuthSessions.get(secondToken)?.sealedSessionKey).toBe(sealedHeader);

    // 2. 客户端仍持旧令牌与旧密钥：下一次加密响应路由请求不再轮换，只重新附带同一新令牌与同一密文，前端实现可解封出新密钥。
    const redeliveredRes: Response = await dispatchRawMiniAppTestRequest(
      statusRequest(login.sessionToken)
    );
    expect(redeliveredRes.status).toBe(200);
    expect(redeliveredRes.headers.get(MINI_APP_SESSION_HEADER)).toBe(secondToken);
    expect(redeliveredRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBe(sealedHeader);
    expect(miniAppAuthSessions.size).toBe(1);
    const secondKeyHex: string = await frontendUnsealRotatedSessionKey(
      firstKey,
      sealedHeader,
      secondToken
    );
    const secondKey: CryptoKey = await importMiniAppAesGcmKey(secondKeyHex);

    // 3. 携带新令牌的慢请求通过只读查找后阻塞在解密；期间另一请求再次轮换、第三个请求确认更新一代令牌。
    const slowEnvelope = await encryptMiniAppEnvelope(
      secondKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const entered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const slowSpy = spyOn(crypto.subtle, "decrypt").mockImplementationOnce(
      async (...args: Parameters<SubtleCrypto["decrypt"]>): Promise<ArrayBuffer> => {
        entered.resolve();
        await release.promise;
        return originalDecrypt(...args);
      }
    );
    let slowRes: Response;
    try {
      const slowPromise: Promise<Response> = dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/totp/setup", {
          method: "POST",
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: secondToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(slowEnvelope),
        })
      );
      await entered.promise;
      setSystemTime(new Date(miniAppAuthSessions.get(secondToken)!.nextRefreshAt + 1));
      const thirdRotationRes: Response = await dispatchRawMiniAppTestRequest(
        statusRequest(secondToken)
      );
      const thirdToken: string = thirdRotationRes.headers.get(MINI_APP_SESSION_HEADER)!;
      expect(thirdToken).not.toBe(secondToken);
      const confirmRes: Response = await dispatchRawMiniAppTestRequest(
        statusRequest(thirdToken)
      );
      expect(confirmRes.status).toBe(200);
      expect(miniAppAuthSessions.get(thirdToken)?.previousToken).toBeUndefined();
      release.resolve();
      slowRes = await slowPromise;
    } finally {
      release.resolve();
      slowSpy.mockRestore();
    }

    expect(slowRes.status).toBe(200);
    expect(slowRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    const slowPlain: string | null = await decryptMiniAppText({
      cryptoKey: secondKey,
      encrypted: parseMiniAppEncryptedEnvelope(await slowRes.json())!,
      additionalData: buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "res"),
    });
    expect(slowPlain).not.toBeNull();
    expect(miniAppAuthSessions.size).toBe(1);

    // 4. 已确认作废的令牌在只读查找阶段即被拒绝：重放同一慢请求返回 401。
    const replayRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: secondToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slowEnvelope),
      })
    );
    expect(replayRes.status).toBe(401);
  });
});
