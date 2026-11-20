/**
 * Mini App TLS 模式临时 X25519 ECDH 协商 + HKDF-SHA256 + 源站静态 Ed25519 验签登录、
 * 握手用完即焚、并发重放/淘汰/低阶点防线、await 窗口竞态、5 会话限额及前端打包公钥注入测试。
 */

import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";
import type {
  InstalledTelegramApi,
  TelegramSentMessage,
} from "../../packages/types/telegramWorker";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppBundledAssetsHolder,
  miniAppInFlightHandshakeIds,
  miniAppLastConsumedTotpStepHolder,
  miniAppPasswordGuardHolder,
  miniAppRejectHtmlHolder,
  miniAppRuntimeSigningKeyHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { telegramApiState } = await import(
  "../../packages/cache/perThread/telegramApi"
);
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_MAX,
  MINI_APP_SESSION_TTL_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_HANDSHAKE_ID_BYTES,
  MINI_APP_HANDSHAKE_MAX,
  MINI_APP_HANDSHAKE_TTL_MS,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
  MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER,
  MINI_APP_SESSION_KEY_BYTES,
  MINI_APP_X25519_PUBLIC_KEY_BYTES,
} = await import("../../packages/consts/miniAppCrypto");
const { MINI_APP_ED25519_SIGNATURE_BYTES } = await import(
  "../../packages/mini-app-frontend/consts/miniAppCrypto"
);
const {
  MINI_APP_TOTP_RECORD_VERSION,
  MINI_APP_TOTP_STEP_SECONDS,
} = await import("../../packages/consts/miniAppTotp");
const { generateMiniAppTotpCodeAt } = await import(
  "../../packages/libs/miniAppTotp"
);
const {
  issueMiniAppAuthSession,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { ensureMiniAppRuntimeSigningKeyPair } = await import(
  "../../packages/mini-app-api-server/auth/handshake"
);
const { revokeOtherMiniAppAuthSessions } = await import(
  "../../packages/mini-app-api-server/auth/session"
);
const {
  buildMiniAppEnvelopeAad,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const {
  decryptMiniAppPayload,
  encryptMiniAppPayload,
} = await import("../../packages/mini-app-frontend/libs/crypto");
const {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} = await import("../../packages/mini-app-frontend/libs/handshakeCrypto");
const { setMiniAppServerSigningPublicKeyForTest } = await import(
  "../../packages/mini-app-frontend/libs/signingKey"
);
const {
  dispatchRawMiniAppTestRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthHandshakeOffer,
  MiniAppAuthPrecheckResponse,
  MiniAppLoginSuccessResponse,
} from "../../packages/types/miniApp/auth";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../../packages/types/miniApp/configs";

const sendMessageStub = mock(
  async (..._args: unknown[]): Promise<TelegramSentMessage> => ({ message_id: 1 })
);

const UTF8_ENCODER: TextEncoder = new TextEncoder();
const REQUEST_AAD_BYTES: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
  MINI_APP_LOGIN_REQUEST_AAD
);
const RESPONSE_AAD_BYTES: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
  MINI_APP_LOGIN_RESPONSE_AAD
);
const LOW_ORDER_ZERO_X25519_PUBLIC_KEY_BASE64: string = new Uint8Array(
  MINI_APP_X25519_PUBLIC_KEY_BYTES
).toBase64();

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

function adminHeaders(): Record<string, string> {
  return {
    [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
    "Content-Type": "application/json",
  };
}

async function fetchPrecheckOffer(): Promise<Readonly<MiniAppAuthHandshakeOffer>> {
  const res: Response = await dispatchRawMiniAppTestRequest(
    new Request("http://127.0.0.1:3000/api/auth/precheck", {
      method: "GET",
      headers: {
        [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      },
    })
  );
  expect(res.status).toBe(200);
  const body: MiniAppAuthPrecheckResponse =
    (await res.json()) as MiniAppAuthPrecheckResponse;
  expect(body.handshake).toBeDefined();
  return body.handshake!;
}

/**
 * 以前端客户端实现核验预检握手签名：临时注入指定源站 Ed25519 公钥后调用 `verifyMiniAppHandshakeOfferDetailed`。
 * @param signingPublicKeyBase64 用于验签的 32 字节源站 Ed25519 公钥 Base64。
 * @param offer 待核验的握手凭据。
 * @returns 结构合法且验签通过时返回 `true`。
 */
async function verifyOfferAsClient(
  signingPublicKeyBase64: string,
  offer: unknown
): Promise<boolean> {
  setMiniAppServerSigningPublicKeyForTest(signingPublicKeyBase64);
  try {
    return (await verifyMiniAppHandshakeOfferDetailed(offer)).ok;
  } finally {
    setMiniAppServerSigningPublicKeyForTest(null);
  }
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppInFlightHandshakeIds.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppBundledAssetsHolder.current = null;
  miniAppRejectHtmlHolder.current = null;
  telegramApiState.current = null;
  sendMessageStub.mockClear();
  setSystemTime();
});

describe("Mini App TLS 模式 X25519 ECDH + Ed25519 验签登录握手", () => {
  test("GET /api/auth/precheck 下发 Ed25519 签名的临时 X25519 公钥，POST /api/auth/login 完成双向加密交换与用完即焚，旧 /api/auth/session-key 路由已移除", async () => {
    const baseMs: number = 1_780_000_000_000;
    setSystemTime(new Date(baseMs));

    const offer: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    expect(Object.keys(offer).sort()).toEqual([
      "expiresAt",
      "handshakeId",
      "serverPublicKey",
      "signature",
    ]);
    expect(Uint8Array.fromHex(offer.handshakeId).byteLength).toBe(
      MINI_APP_HANDSHAKE_ID_BYTES
    );
    expect(Uint8Array.fromBase64(offer.serverPublicKey).byteLength).toBe(
      MINI_APP_X25519_PUBLIC_KEY_BYTES
    );
    expect(Uint8Array.fromBase64(offer.signature).byteLength).toBe(
      MINI_APP_ED25519_SIGNATURE_BYTES
    );
    expect(offer.expiresAt).toBe(baseMs + MINI_APP_HANDSHAKE_TTL_MS);
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppAuthHandshakes.has(offer.handshakeId)).toBeTrue();

    const runtimeSigningKey = await ensureMiniAppRuntimeSigningKeyPair();
    expect(await verifyOfferAsClient(runtimeSigningKey.publicKeyBase64, offer)).toBeTrue();
    expect(
      await verifyOfferAsClient(runtimeSigningKey.publicKeyBase64, {
        ...offer,
        serverPublicKey: LOW_ORDER_ZERO_X25519_PUBLIC_KEY_BASE64,
      })
    ).toBeFalse();
    expect(
      await verifyOfferAsClient(runtimeSigningKey.publicKeyBase64, {
        ...offer,
        handshakeId: "f".repeat(MINI_APP_HANDSHAKE_ID_BYTES * 2),
      })
    ).toBeFalse();

    const clientKeyPair = await generateClientMiniAppX25519KeyPair();
    const derived = await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: clientKeyPair.privateKey,
      serverPublicKeyBase64: offer.serverPublicKey,
      clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
      handshakeId: offer.handshakeId,
    });

    const password: string = getBotMiniAppConfig()!.password;
    const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
      await encryptMiniAppPayload(
        derived.c2sKey,
        JSON.stringify({ handshakeId: offer.handshakeId, password }),
        REQUEST_AAD_BYTES
      );
    const wireBody: string = JSON.stringify({
      handshakeId: offer.handshakeId,
      clientPublicKey: clientKeyPair.publicKeyBase64,
      encryptedPayload,
    });

    const loginRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: adminHeaders(),
        body: wireBody,
      })
    );
    expect(loginRes.status).toBe(200);
    expect(miniAppAuthHandshakes.has(offer.handshakeId)).toBeFalse();
    expect(miniAppAuthHandshakes.size).toBe(0);
    expect(miniAppInFlightHandshakeIds.size).toBe(0);
    expect(miniAppAuthSessions.size).toBe(1);

    const rawText: string = await loginRes.text();
    expect(rawText).not.toContain("sessionToken");
    expect(rawText).not.toContain("sessionKey");
    const envelope: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(JSON.parse(rawText));
    expect(envelope).not.toBeNull();
    const plainText: string = await decryptMiniAppPayload(
      derived.s2cKey,
      envelope!,
      RESPONSE_AAD_BYTES
    );
    const loginBody: MiniAppLoginSuccessResponse = JSON.parse(
      plainText
    ) as MiniAppLoginSuccessResponse;
    expect(loginBody).toEqual({
      ok: true,
      sessionToken: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sessionKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expiresAt: baseMs + MINI_APP_SESSION_TTL_MS,
      ttlMs: MINI_APP_SESSION_TTL_MS,
    });
    expect(Uint8Array.fromHex(loginBody.sessionKey).byteLength).toBe(
      MINI_APP_SESSION_KEY_BYTES
    );
    expect(
      miniAppAuthSessions.get(loginBody.sessionToken)?.pendingSessionKey
    ).toBeUndefined();

    // 重放同一握手的请求立即被拒绝（用完即焚）。
    const replayRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: adminHeaders(),
        body: wireBody,
      })
    );
    expect(replayRes.status).toBe(400);
    expect(await replayRes.json()).toEqual({
      ok: false,
      code: MINI_APP_INVALID_HANDSHAKE_CODE,
      error: MINI_APP_INVALID_HANDSHAKE_CODE,
    });
    expect(miniAppAuthSessions.size).toBe(1);

    // 旧 /api/auth/session-key 路由已彻底移除：按未知兜底路径拦截（无会话 401、带会话 404）。
    const removedNoSessionRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/session-key", {
        method: "POST",
        headers: adminHeaders(),
        body: "{}",
      })
    );
    expect(removedNoSessionRes.status).toBe(401);
    const sessionCryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      loginBody.sessionKey
    );
    const removedEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        sessionCryptoKey,
        "{}",
        buildMiniAppEnvelopeAad("POST", "/api/auth/session-key", "req")
      );
    const removedRouteRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/session-key", {
        method: "POST",
        headers: {
          ...adminHeaders(),
          "x-mini-app-session": loginBody.sessionToken,
        },
        body: JSON.stringify(removedEnvelope),
      })
    );
    expect(removedRouteRes.status).toBe(404);
  });

  test("拒绝畸形登录体、未知/过期/FIFO 淘汰握手、全零低阶 X25519 公钥、错 AAD、内层 handshakeId 不一致与并发在途重放", async () => {
    const baseMs: number = 1_781_000_000_000;
    setSystemTime(new Date(baseMs));

    const offer1: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    const client1 = await generateClientMiniAppX25519KeyPair();
    const derived1 = await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: client1.privateKey,
      serverPublicKeyBase64: offer1.serverPublicKey,
      clientPublicKeyBase64: client1.publicKeyBase64,
      handshakeId: offer1.handshakeId,
    });
    const password: string = getBotMiniAppConfig()!.password;
    const validEncrypted: Readonly<MiniAppEncryptedPayload> =
      await encryptMiniAppPayload(
        derived1.c2sKey,
        JSON.stringify({ handshakeId: offer1.handshakeId, password }),
        REQUEST_AAD_BYTES
      );

    // 外层结构/未命中握手校验失败的请求直接返回 400。
    const preHandshakeRejectedBodies: readonly unknown[] = [
      {},
      { password },
      { handshakeId: offer1.handshakeId, clientPublicKey: client1.publicKeyBase64 },
      {
        handshakeId: offer1.handshakeId,
        clientPublicKey: client1.publicKeyBase64,
        encryptedPayload: validEncrypted,
        extra: 1,
      },
      {
        handshakeId: 123,
        clientPublicKey: client1.publicKeyBase64,
        encryptedPayload: validEncrypted,
      },
      {
        handshakeId: offer1.handshakeId,
        clientPublicKey: client1.publicKeyBase64,
        encryptedPayload: { iv: "bad", payload: "bad" },
      },
      {
        handshakeId: "0".repeat(32),
        clientPublicKey: client1.publicKeyBase64,
        encryptedPayload: validEncrypted,
      },
    ];
    for (const candidate of preHandshakeRejectedBodies) {
      const badRes: Response = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify(candidate),
        })
      );
      expect(badRes.status).toBe(400);
      expect(await badRes.json()).toEqual({
        ok: false,
        code: MINI_APP_INVALID_HANDSHAKE_CODE,
        error: MINI_APP_INVALID_HANDSHAKE_CODE,
      });
    }

    // 在途并发重放锁命中的握手 ID 立即被拒绝，且未提前破坏合法 offer1。
    miniAppInFlightHandshakeIds.add(offer1.handshakeId);
    const inFlightRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          handshakeId: offer1.handshakeId,
          clientPublicKey: client1.publicKeyBase64,
          encryptedPayload: validEncrypted,
        }),
      })
    );
    expect(inFlightRes.status).toBe(400);
    expect(((await inFlightRes.json()) as MiniAppAccessDiagnostics).code).toBe(
      MINI_APP_INVALID_HANDSHAKE_CODE
    );
    miniAppInFlightHandshakeIds.delete(offer1.handshakeId);

    // 进入 acquireMiniAppAuthHandshake 之后若遇到非法公钥、错 AAD、错握手绑定、多/缺字段或非 JSON，必须即刻销毁该握手（重放立即失败）。
    const burnCheckBuilders: readonly ((
      offer: Readonly<MiniAppAuthHandshakeOffer>
    ) => Promise<unknown>)[] = [
      async (offer) => ({
        handshakeId: offer.handshakeId,
        clientPublicKey: LOW_ORDER_ZERO_X25519_PUBLIC_KEY_BASE64,
        encryptedPayload: validEncrypted,
      }),
      async (offer) => ({
        handshakeId: offer.handshakeId,
        clientPublicKey: "not-base64",
        encryptedPayload: validEncrypted,
      }),
      async (offer) => {
        const otherClient = await generateClientMiniAppX25519KeyPair();
        const otherDerived = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: otherClient.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: otherClient.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: client1.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            otherDerived.c2sKey,
            JSON.stringify({ handshakeId: offer.handshakeId, password }),
            REQUEST_AAD_BYTES
          ),
        };
      },
      async (offer) => {
        const c = await generateClientMiniAppX25519KeyPair();
        const d = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: c.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: c.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: c.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            d.c2sKey,
            JSON.stringify({ handshakeId: offer.handshakeId, password }),
            UTF8_ENCODER.encode("POST /api/other")
          ),
        };
      },
      async (offer) => {
        const c = await generateClientMiniAppX25519KeyPair();
        const d = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: c.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: c.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: c.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            d.c2sKey,
            JSON.stringify({ handshakeId: "f".repeat(32), password }),
            REQUEST_AAD_BYTES
          ),
        };
      },
      async (offer) => {
        const c = await generateClientMiniAppX25519KeyPair();
        const d = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: c.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: c.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: c.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            d.c2sKey,
            JSON.stringify({ handshakeId: offer.handshakeId }),
            REQUEST_AAD_BYTES
          ),
        };
      },
      async (offer) => {
        const c = await generateClientMiniAppX25519KeyPair();
        const d = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: c.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: c.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: c.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            d.c2sKey,
            JSON.stringify({
              handshakeId: offer.handshakeId,
              password,
              totpCode: "123456",
            }),
            REQUEST_AAD_BYTES
          ),
        };
      },
      async (offer) => {
        const c = await generateClientMiniAppX25519KeyPair();
        const d = await deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: c.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: c.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
        return {
          handshakeId: offer.handshakeId,
          clientPublicKey: c.publicKeyBase64,
          encryptedPayload: await encryptMiniAppPayload(
            d.c2sKey,
            "not-json",
            REQUEST_AAD_BYTES
          ),
        };
      },
    ];
    for (const buildBody of burnCheckBuilders) {
      const freshOffer = await fetchPrecheckOffer();
      const body = await buildBody(freshOffer);
      const badRes: Response = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify(body),
        })
      );
      expect(badRes.status).toBe(400);
      expect(await badRes.json()).toEqual({
        ok: false,
        code: MINI_APP_INVALID_HANDSHAKE_CODE,
        error: MINI_APP_INVALID_HANDSHAKE_CODE,
      });
      expect(miniAppAuthHandshakes.has(freshOffer.handshakeId)).toBeFalse();
    }

    // 超过 5 分钟 TTL 的握手过期销毁并拒绝。
    setSystemTime(new Date(baseMs + MINI_APP_HANDSHAKE_TTL_MS + 1));
    const expiredRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          handshakeId: offer1.handshakeId,
          clientPublicKey: client1.publicKeyBase64,
          encryptedPayload: validEncrypted,
        }),
      })
    );
    expect(expiredRes.status).toBe(400);
    expect(miniAppAuthHandshakes.has(offer1.handshakeId)).toBeFalse();

    // 连续签发超出 MINI_APP_HANDSHAKE_MAX 时按 FIFO 淘汰最早未消费握手。
    const firstOffer: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    for (let i: number = 0; i < MINI_APP_HANDSHAKE_MAX; i += 1) {
      await fetchPrecheckOffer();
    }
    expect(miniAppAuthHandshakes.size).toBe(MINI_APP_HANDSHAKE_MAX);
    expect(miniAppAuthHandshakes.has(firstOffer.handshakeId)).toBeFalse();
  });

  test("4 个活跃会话下双握手先后登录均成功且第二次淘汰最早会话，锁定、TOTP 变更与停机清空全部待用握手", async () => {
    const baseMs: number = 1_782_000_000_000;
    setSystemTime(new Date(baseMs));
    const seededTokens: string[] = [];
    for (let i: number = 0; i < MINI_APP_SESSION_MAX - 1; i += 1) {
      seededTokens.push(issueMiniAppAuthSession(baseMs).token);
    }
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX - 1);

    const offerA: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    const offerB: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    expect(offerA.handshakeId).not.toBe(offerB.handshakeId);

    const password: string = getBotMiniAppConfig()!.password;
    const resA = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password },
      handshakeOverride: offerA,
    });
    expect(resA.status).toBe(200);
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    expect(miniAppAuthHandshakes.has(offerA.handshakeId)).toBeFalse();

    // 客户端 B 凭据合法且已满 5 会话：照常以 s2cKey 加密签发，淘汰最早签发的会话并销毁其握手。
    const resB = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password },
      handshakeOverride: offerB,
    });
    expect(resB.status).toBe(200);
    expect(
      parseMiniAppEncryptedEnvelope(await resB.loginResponse.clone().json())
    ).not.toBeNull();
    expect(miniAppAuthHandshakes.has(offerB.handshakeId)).toBeFalse();
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    expect(miniAppAuthSessions.has(seededTokens[0]!)).toBeFalse();
    expect(miniAppAuthSessions.has(String(resA.payload.sessionToken))).toBeTrue();
    expect(miniAppAuthSessions.has(String(resB.payload.sessionToken))).toBeTrue();

    // 验证器变更（revokeOtherMiniAppAuthSessions）清空未消费握手记录。
    miniAppAuthSessions.clear();
    const keepSession = issueMiniAppAuthSession(baseMs);
    const pendingBeforeChange: Readonly<MiniAppAuthHandshakeOffer> =
      await fetchPrecheckOffer();
    expect(miniAppAuthHandshakes.has(pendingBeforeChange.handshakeId)).toBeTrue();
    revokeOtherMiniAppAuthSessions(keepSession.lineageId, baseMs);
    expect(miniAppAuthHandshakes.size).toBe(0);
    expect(miniAppAuthSessions.has(keepSession.token)).toBeTrue();

    // 连续 3 次输错密码触发锁定后：3 次响应均 s2c 加密返回 403，清空会话与握手，并发送 1 次告警私聊。
    telegramApiState.current = {
      sendMessage: sendMessageStub,
    } as unknown as InstalledTelegramApi;
    for (
      let attempt: number = 1;
      attempt <= MINI_APP_PASSWORD_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const failAttempt = await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password: `wrong-${attempt}` },
      });
      expect(failAttempt.status).toBe(403);
      expect(
        parseMiniAppEncryptedEnvelope(
          await failAttempt.loginResponse.clone().json()
        )
      ).not.toBeNull();
      expect((failAttempt.payload as unknown as MiniAppAccessDiagnostics).code).toBe(
        attempt < MINI_APP_PASSWORD_MAX_ATTEMPTS
          ? "INVALID_PASSWORD"
          : "PASSWORD_LOCKED"
      );
    }
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppAuthHandshakes.size).toBe(0);
    expect(sendMessageStub).toHaveBeenCalledTimes(1);

    // 解除锁定后验证 stopMiniAppServer 清空待用握手与活跃会话。
    miniAppPasswordGuardHolder.current = null;
    await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password },
    });
    await fetchPrecheckOffer();
    expect(miniAppAuthSessions.size).toBe(1);
    expect(miniAppAuthHandshakes.size).toBe(1);
    await stopMiniAppServer();
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppAuthHandshakes.size).toBe(0);
  });

  test("await 解密窗口内握手被吊销后，POST /api/auth/login 返回 400 INVALID_HANDSHAKE 且不签发会话", async () => {
    const baseMs: number = 1_777_010_000_000;
    setSystemTime(new Date(baseMs));
    const offer: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
    const client = await generateClientMiniAppX25519KeyPair();
    const derived = await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: client.privateKey,
      serverPublicKeyBase64: offer.serverPublicKey,
      clientPublicKeyBase64: client.publicKeyBase64,
      handshakeId: offer.handshakeId,
    });
    const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
      await encryptMiniAppPayload(
        derived.c2sKey,
        JSON.stringify({
          handshakeId: offer.handshakeId,
          password: getBotMiniAppConfig()!.password,
        }),
        REQUEST_AAD_BYTES
      );

    const realDecrypt: typeof crypto.subtle.decrypt = crypto.subtle.decrypt.bind(
      crypto.subtle
    );
    const decryptSpy = spyOn(crypto.subtle, "decrypt").mockImplementation(
      async (
        ...args: Parameters<typeof crypto.subtle.decrypt>
      ): Promise<ArrayBuffer> => {
        const plainBuffer: ArrayBuffer = await realDecrypt(...args);
        // 模拟在途解密期间因 TOTP 变更/吊销清除了该临时握手。
        miniAppAuthHandshakes.delete(offer.handshakeId);
        return plainBuffer;
      }
    );
    try {
      const raceRes: Response = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({
            handshakeId: offer.handshakeId,
            clientPublicKey: client.publicKeyBase64,
            encryptedPayload,
          }),
        })
      );
      expect(raceRes.status).toBe(400);
      const body: Readonly<Record<string, unknown>> =
        (await raceRes.json()) as Readonly<Record<string, unknown>>;
      expect(body.code).toBe(MINI_APP_INVALID_HANDSHAKE_CODE);
      expect(miniAppAuthSessions.size).toBe(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("每次启动重新生成 Ed25519 密钥对并在前端静态 JS 产物物化时注入当次公钥、重算 ETag", async () => {
    const startAndFetchBundle = async (): Promise<{
      readonly pubKeyBase64: string;
      readonly offer: Readonly<MiniAppAuthHandshakeOffer>;
      readonly chunkText: string;
      readonly etag: string;
    }> => {
      const server = startMiniAppServer({
        url: "https://miniapp.example.com",
        host: "127.0.0.1",
        port: 0,
        password: "ecdh-bundle-password-123456",
      });
      expect(server).not.toBeNull();
      const origin: string = `http://127.0.0.1:${server!.port}`;
      const runtimeSigningKey = await ensureMiniAppRuntimeSigningKeyPair();
      const pubKeyBase64: string = runtimeSigningKey.publicKeyBase64;

      const superInit: string = adminInitData();
      const preRes: Response = await fetch(`${origin}/api/auth/precheck`, {
        headers: { [MINI_APP_INIT_DATA_HEADER]: superInit },
      });
      expect(preRes.status).toBe(200);
      const preBody: MiniAppAuthPrecheckResponse =
        (await preRes.json()) as MiniAppAuthPrecheckResponse;
      expect(preBody.handshake).toBeDefined();
      expect(await verifyOfferAsClient(pubKeyBase64, preBody.handshake!)).toBeTrue();
      const gateCookiePair: string = (preRes.headers.get("set-cookie") ?? "").split(";")[0]!;

      const pageRes: Response = await fetch(`${origin}/`, {
        headers: { Cookie: gateCookiePair },
      });
      expect(pageRes.status).toBe(200);
      const html: string = await pageRes.text();
      const scriptChunkMatch: RegExpMatchArray | null = html.match(
        /src="(\.\/chunk-[a-z0-9]+\.js)"/iu
      );
      expect(scriptChunkMatch).not.toBeNull();

      const chunkPath: string = scriptChunkMatch![1]!.slice(1);
      const chunkRes: Response = await fetch(`${origin}${chunkPath}`, {
        headers: {
          Cookie: gateCookiePair,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Dest": "script",
        },
      });
      expect(chunkRes.status).toBe(200);
      const etag: string = chunkRes.headers.get("etag") ?? "";
      expect(etag.length).toBeGreaterThan(2);
      const chunkText: string = await chunkRes.text();
      expect(chunkText).toContain(pubKeyBase64);
      expect(chunkText).not.toContain(
        MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER
      );
      return { pubKeyBase64, offer: preBody.handshake!, chunkText, etag };
    };

    const run1 = await startAndFetchBundle();
    await stopMiniAppServer();
    expect(miniAppRuntimeSigningKeyHolder.current).toBeNull();
    expect(miniAppBundledAssetsHolder.current).toBeNull();

    const run2 = await startAndFetchBundle();
    expect(run2.pubKeyBase64).not.toBe(run1.pubKeyBase64);
    expect(run2.etag).not.toBe(run1.etag);
    expect(run2.chunkText).not.toContain(run1.pubKeyBase64);
    expect(await verifyOfferAsClient(run1.pubKeyBase64, run2.offer)).toBeFalse();
  });

  test("同一 initData 并发登录在锁定后不再比对凭据，正确密码同样触发 403 PASSWORD_LOCKED 且告警仅发一次", async () => {
    const burstInitData: string = adminInitData();
    const burstSize: number = MINI_APP_HANDSHAKE_MAX;
    const burstStartMs: number = Date.now();
    const preparedBodies: string[] = [];
    const responseKeys: CryptoKey[] = [];
    for (let index: number = 0; index < burstSize; index++) {
      const preBodyOffer: Readonly<MiniAppAuthHandshakeOffer> = await fetchPrecheckOffer();
      const clientKeyPair = await generateClientMiniAppX25519KeyPair();
      const derived = await deriveClientMiniAppHandshakeKeys({
        clientPrivateKey: clientKeyPair.privateKey,
        serverPublicKeyBase64: preBodyOffer.serverPublicKey,
        clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
        handshakeId: preBodyOffer.handshakeId,
      });
      const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
        await encryptMiniAppPayload(
          derived.c2sKey,
          JSON.stringify({
            handshakeId: preBodyOffer.handshakeId,
            password:
              index + 1 < burstSize
                ? `bad-password-${index}`
                : getBotMiniAppConfig()!.password,
          }),
          REQUEST_AAD_BYTES
        );
      preparedBodies.push(
        JSON.stringify({
          handshakeId: preBodyOffer.handshakeId,
          clientPublicKey: clientKeyPair.publicKeyBase64,
          encryptedPayload,
        })
      );
      responseKeys.push(derived.s2cKey);
    }

    const bodyControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    telegramApiState.current = {
      sendMessage: sendMessageStub,
    } as unknown as InstalledTelegramApi;
    const pending: Promise<Response>[] = [];
    for (let index: number = 0; index < burstSize; index++) {
      pending.push(
        dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/auth/login", {
            method: "POST",
            headers: {
              [MINI_APP_INIT_DATA_HEADER]: burstInitData,
              "Content-Type": "application/json",
            },
            body: new ReadableStream<Uint8Array>({
              start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                bodyControllers.push(controller);
              },
            }),
          })
        )
      );
    }
    for (let index: number = 0; index < burstSize - 1; index++) {
      bodyControllers[index]?.enqueue(UTF8_ENCODER.encode(preparedBodies[index]!));
      bodyControllers[index]?.close();
    }
    await Promise.allSettled(pending.slice(0, burstSize - 1));
    bodyControllers[burstSize - 1]?.enqueue(
      UTF8_ENCODER.encode(preparedBodies[burstSize - 1]!)
    );
    bodyControllers[burstSize - 1]?.close();
    const settled: PromiseSettledResult<Response>[] = await Promise.allSettled(pending);
    const codes: string[] = [];
    for (let index: number = 0; index < settled.length; index += 1) {
      const result: PromiseSettledResult<Response> = settled[index]!;
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.status).toBe(403);
      const rawJson: unknown = await result.value.json();
      const envelope: Readonly<MiniAppEncryptedEnvelope> | null =
        parseMiniAppEncryptedEnvelope(rawJson);
      if (envelope !== null) {
        const plain: string = await decryptMiniAppPayload(
          responseKeys[index]!,
          envelope,
          RESPONSE_AAD_BYTES
        );
        codes.push((JSON.parse(plain) as MiniAppAccessDiagnostics).code);
      } else {
        codes.push((rawJson as MiniAppAccessDiagnostics).code);
      }
    }

    expect(codes.filter((code: string): boolean => code === "INVALID_PASSWORD").length).toBe(
      MINI_APP_PASSWORD_MAX_ATTEMPTS - 1
    );
    expect(codes.filter((code: string): boolean => code === "PASSWORD_LOCKED").length).toBe(
      burstSize - (MINI_APP_PASSWORD_MAX_ATTEMPTS - 1)
    );
    expect(codes[burstSize - 1]).toBe("PASSWORD_LOCKED");
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppPasswordGuardHolder.current?.failedAttempts ?? 0).toBeGreaterThanOrEqual(
      MINI_APP_PASSWORD_MAX_ATTEMPTS
    );
    expect(miniAppPasswordGuardHolder.current?.failedAttempts ?? 0).toBeLessThanOrEqual(
      burstSize
    );
    expect(miniAppPasswordGuardHolder.current?.lockedUntil ?? 0).toBeGreaterThanOrEqual(
      burstStartMs + MINI_APP_PASSWORD_LOCKOUT_MS
    );
    expect(sendMessageStub).toHaveBeenCalledTimes(1);
  });

  test("TOTP 启用后严格拒绝同一 30 秒时间步动态码二次重放，会话满额时登录淘汰最早会话并照常消耗当步动态码", async () => {
    const baseMs: number = 1_787_000_000_000;
    setSystemTime(new Date(baseMs));
    const totpSecret: string = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    miniAppTotpRecordHolder.current = {
      version: MINI_APP_TOTP_RECORD_VERSION,
      secret: totpSecret,
      createdAt: baseMs,
    };
    const currentCode: string = generateMiniAppTotpCodeAt(totpSecret, baseMs);

    // 1. 先塞满 5 个活跃会话：合法动态码登录照常成功、淘汰最早会话，并记录已消费步进。
    const seededTokens: string[] = [];
    for (let i: number = 0; i < MINI_APP_SESSION_MAX; i += 1) {
      seededTokens.push(issueMiniAppAuthSession(baseMs).token);
    }
    const firstSuccess = await performMiniAppTestEcdhLogin({
      initData: adminHeaders()[MINI_APP_INIT_DATA_HEADER]!,
      credentialPayload: { totpCode: currentCode },
    });
    expect(firstSuccess.status).toBe(200);
    expect(miniAppAuthSessions.has(seededTokens[0]!)).toBeFalse();
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    expect(miniAppLastConsumedTotpStepHolder.current?.secret).toBe(totpSecret);

    // 2. 在同一 30 秒时间步内重放相同动态码必须返回 403 INVALID_TOTP_CODE。
    const replayAttempt = await performMiniAppTestEcdhLogin({
      initData: adminHeaders()[MINI_APP_INIT_DATA_HEADER]!,
      credentialPayload: { totpCode: currentCode },
    });
    expect(replayAttempt.status).toBe(403);
    expect((replayAttempt.payload as unknown as MiniAppAccessDiagnostics).code).toBe(
      "INVALID_TOTP_CODE"
    );

    // 3. 推进至下一个 30 秒时间步后新动态码正常登录成功。
    const nextStepMs: number = baseMs + MINI_APP_TOTP_STEP_SECONDS * 1_000;
    setSystemTime(new Date(nextStepMs));
    const nextCode: string = generateMiniAppTotpCodeAt(totpSecret, nextStepMs);
    const nextStepSuccess = await performMiniAppTestEcdhLogin({
      initData: adminHeaders()[MINI_APP_INIT_DATA_HEADER]!,
      credentialPayload: { totpCode: nextCode },
    });
    expect(nextStepSuccess.status).toBe(200);
  });
});
