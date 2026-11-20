/**
 * Mini App 前端 Web Crypto AES-256-GCM 会话加密传输、登录凭据裁决防降级与 JSON 词法高亮解析器单元测试。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loginMiniAppWithPassword } from "../../packages/mini-app-frontend/api/authLogin";
import { uploadMiniAppGalleryImageBytes } from "../../packages/mini-app-frontend/api/galleryUpload";
import {
  miniAppFetchJson,
  resolveCanonicalMiniAppApiPath,
} from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
  MINI_APP_SESSION_KEY_BYTES,
  MINI_APP_SESSION_KEY_HEADER,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hasMiniAppSessionCryptoKey,
  hydrateMiniAppSessionFromStorage,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  decryptMiniAppBinary as decryptServerBinary,
  decryptMiniAppText as decryptServerText,
  encryptMiniAppEnvelope as encryptServerEnvelope,
  sealRotatedMiniAppSessionKey,
  unsealMiniAppQuery,
} from "../../packages/mini-app-api-server/libs/crypto";
import {
  deriveMiniAppHandshakeKeys as deriveServerHandshakeKeys,
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair as generateServerX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../../packages/mini-app-api-server/libs/handshakeCrypto";
import {
  base64ToBytes,
  buildMiniAppEnvelopeAad,
  bytesToBase64,
  decryptMiniAppPayload,
  encodeUtf8Bytes,
  encryptMiniAppEnvelope,
  encryptMiniAppPayload,
  hexToBytes,
  importMiniAppAesGcmKey,
  isMiniAppEncryptedEnvelope,
  isValidMiniAppHexKey,
  sealMiniAppQuery,
  unsealRotatedSessionKey,
} from "../../packages/mini-app-frontend/libs/crypto";
import {
  clearPendingMiniAppAuthHandshake,
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} from "../../packages/mini-app-frontend/libs/handshakeCrypto";
import {
  getMiniAppServerSigningPublicKey,
  setMiniAppServerSigningPublicKeyForTest,
} from "../../packages/mini-app-frontend/libs/signingKey";
import {
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppEncryptedLoginRequest,
  MiniAppEncryptedPayload,
} from "../../packages/mini-app-frontend/types/miniApp";
import {
  createInMemoryIdbFactory,
  seedTestMiniAppSession,
  TEST_ROTATED_SESSION_KEY,
  TEST_RUNTIME_SIGNING_KEY_PAIR,
  TEST_SESSION_KEY,
} from "./helpers/encryptedFetchMock";

const originalFetch: typeof fetch = globalThis.fetch;
const originalIndexedDb: unknown = (globalThis as { indexedDB?: unknown }).indexedDB;

beforeEach((): void => {
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "signed-superadmin-initdata" },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
  clearPendingMiniAppAuthHandshake();
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  globalThis.fetch = originalFetch;
  if (originalIndexedDb === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
  }
  Reflect.deleteProperty(globalThis, "Telegram");
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "sessionStorage");
  setMiniAppServerSigningPublicKeyForTest(null);
  clearPendingMiniAppAuthHandshake();
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
});

describe("Web Crypto 256-bit 会话加解密与密钥生命周期", () => {
  test("纯 JS 十六进制/Base64 编解码、AES-256-GCM 随机 IV 加解密、篡改拒绝与续期密钥 AAD 绑定", async () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    expect((): Uint8Array => base64ToBytes("")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    for (const byteLen of [1, 2, 3, 12, 16, MINI_APP_SESSION_KEY_BYTES]) {
      const sample: Uint8Array<ArrayBuffer> = new Uint8Array(byteLen);
      for (let i: number = 0; i < byteLen; i += 1) {
        sample[i] = (i * 37 + 13) & 0xff;
      }
      const hex: string = Array.from(
        sample,
        (byte: number): string => byte.toString(16).padStart(2, "0")
      ).join("");
      expect(Array.from(hexToBytes(hex))).toEqual(Array.from(sample));
      const b64: string = bytesToBase64(sample);
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(sample));
    }

    expect((): Uint8Array => hexToBytes("")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );

    expect((): Uint8Array => hexToBytes("abc")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    expect((): Uint8Array => hexToBytes("zz")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    expect((): Uint8Array => base64ToBytes("abc")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    expect(isValidMiniAppHexKey(TEST_SESSION_KEY)).toBeTrue();
    expect(isValidMiniAppHexKey("short")).toBeFalse();

    const key: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
    const plainJson: string = JSON.stringify({
      hello: "杂鱼♡",
      nested: [1, true, null],
    });
    const env1 = await encryptMiniAppEnvelope(key, plainJson);
    const env2 = await encryptMiniAppEnvelope(key, plainJson);
    expect(isMiniAppEncryptedEnvelope(env1)).toBeTrue();
    expect(base64ToBytes(env1.iv).byteLength).toBe(MINI_APP_AES_GCM_IV_BYTES);
    expect(env1.iv).not.toBe(env2.iv);
    expect(await decryptMiniAppPayload(key, env1)).toBe(plainJson);

    // 篡改密文末尾字节时 GCM 128-bit 认证标签校验失败。
    const rawCipher: Uint8Array<ArrayBuffer> = base64ToBytes(env1.payload);
    rawCipher[rawCipher.byteLength - 1] =
      (rawCipher[rawCipher.byteLength - 1] ?? 0) ^ 0xff;
    await expect(
      decryptMiniAppPayload(key, {
        iv: env1.iv,
        payload: bytesToBase64(rawCipher),
      })
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);

    // 未注入真实公钥（保留构建占位符）时必须 fail-closed 拒绝导入。
    setMiniAppServerSigningPublicKeyForTest(null);
    await expect(getMiniAppServerSigningPublicKey()).rejects.toThrow(
      MINI_APP_INVALID_HANDSHAKE_CODE
    );
    const runtimeSigningKey = await generateMiniAppEd25519KeyPair();
    setMiniAppServerSigningPublicKeyForTest(runtimeSigningKey.publicKeyBase64);

    // 临时 X25519 握手 Ed25519 验签与双向 c2s/s2c HKDF 派生前后端严格对称。
    const serverKeyPair = await generateServerX25519KeyPair();
    const signingKey: CryptoKey = runtimeSigningKey.privateKey;
    const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "0123456789abcdef0123456789abcdef",
      serverPublicKey: serverKeyPair.publicKeyBase64,
      expiresAt: Date.now() + 300_000,
    };
    const signedOffer: Readonly<MiniAppAuthHandshakeOffer> = {
      ...unsignedOffer,
      signature: await signMiniAppHandshakeOffer(signingKey, unsignedOffer),
    };
    expect(await verifyMiniAppHandshakeOfferDetailed(signedOffer)).toEqual({ ok: true, offer: signedOffer });
    expect(
      (await verifyMiniAppHandshakeOfferDetailed({
        ...signedOffer,
        expiresAt: signedOffer.expiresAt + 1,
      })).ok
    ).toBeFalse();
    expect(
      (await verifyMiniAppHandshakeOfferDetailed({
        ...signedOffer,
        serverPublicKey: bytesToBase64(new Uint8Array(32)),
      })).ok
    ).toBeFalse();

    const clientKeyPair = await generateClientMiniAppX25519KeyPair();
    const clientDerived = await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: clientKeyPair.privateKey,
      serverPublicKeyBase64: signedOffer.serverPublicKey,
      clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
      handshakeId: signedOffer.handshakeId,
    });
    const serverDerived = await deriveServerHandshakeKeys({
      serverPrivateKey: serverKeyPair.privateKey,
      handshakeId: signedOffer.handshakeId,
      serverPublicKeyBase64: signedOffer.serverPublicKey,
      clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
    });
    expect(serverDerived).not.toBeNull();

    const requestAadBytes: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
      MINI_APP_LOGIN_REQUEST_AAD
    );
    const responseAadBytes: Uint8Array<ArrayBuffer> = encodeUtf8Bytes(
      MINI_APP_LOGIN_RESPONSE_AAD
    );
    const encryptedLoginReq: Readonly<MiniAppEncryptedPayload> =
      await encryptMiniAppPayload(
        clientDerived.c2sKey,
        JSON.stringify({ handshakeId: signedOffer.handshakeId, password: "pw" }),
        requestAadBytes
      );
    expect(
      await decryptServerText({
        cryptoKey: serverDerived!.c2sKey,
        encrypted: encryptedLoginReq,
        additionalData: requestAadBytes,
      })
    ).toBe(JSON.stringify({ handshakeId: signedOffer.handshakeId, password: "pw" }));
    expect(
      await decryptServerText({
        cryptoKey: serverDerived!.c2sKey,
        encrypted: encryptedLoginReq,
        additionalData: encodeUtf8Bytes("POST /api/other"),
      })
    ).toBeNull();

    const encryptedLoginRes = await encryptServerEnvelope(
      serverDerived!.s2cKey,
      JSON.stringify({ ok: true, sessionToken: "a".repeat(64) }),
      responseAadBytes
    );
    expect(
      await decryptMiniAppPayload(
        clientDerived.s2cKey,
        encryptedLoginRes,
        responseAadBytes
      )
    ).toBe(JSON.stringify({ ok: true, sessionToken: "a".repeat(64) }));

    // 续期密钥封装绑定新会话令牌作为 AAD，令牌不匹配时拒绝解封。
    const nextToken: string = "a".repeat(64);
    const sealed: string = await sealRotatedMiniAppSessionKey(
      key,
      TEST_ROTATED_SESSION_KEY,
      nextToken
    );
    expect(await unsealRotatedSessionKey(key, sealed, nextToken)).toBe(
      TEST_ROTATED_SESSION_KEY
    );
    await expect(
      unsealRotatedSessionKey(key, sealed, "b".repeat(64))
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  });

  test("登录缓存会话密钥、后续加密通信绝不外泄密钥、滑动续期解封轮换、缺失密钥存储自清与登出擦除", async () => {
    const issuedToken: string = "1".repeat(64);
    const rotatedToken: string = "2".repeat(64);
    const localStoreMap: Map<string, string> = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string): string | null => localStoreMap.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        localStoreMap.set(k, v);
      },
      removeItem: (k: string): void => {
        localStoreMap.delete(k);
      },
    };
    const sessionStoreMap: Map<string, string> = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string): string | null => sessionStoreMap.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        sessionStoreMap.set(k, v);
      },
      removeItem: (k: string): void => {
        sessionStoreMap.delete(k);
      },
    };
    const idbFactory = createInMemoryIdbFactory();
    (globalThis as { indexedDB?: unknown }).indexedDB = idbFactory;

    const outboundWireRecords: {
      readonly path: string;
      readonly headers: Record<string, string>;
      readonly rawBody: string;
    }[] = [];

    let activeOffer: {
      readonly handshakeId: string;
      readonly serverPublicKey: string;
      readonly serverPrivateKey: CryptoKey;
    } | null = null;
    let expectedAuthMode: "password" | "totp" = "password";

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const url: URL = new URL(String(input), "https://mini.test/");
      const hdrs: Record<string, string> = {};
      new Headers(init?.headers).forEach((v: string, k: string): void => {
        hdrs[k.toLowerCase()] = v;
      });
      const rawBody: string =
        typeof init?.body === "string" ? init.body : "";
      outboundWireRecords.push({
        path: `${url.pathname}${url.search}`,
        headers: hdrs,
        rawBody,
      });

      if (url.pathname === "/api/auth/precheck") {
        const pair = await generateServerX25519KeyPair();
        const signingKey: CryptoKey = TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey;
        const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
          handshakeId: "0123456789abcdef0123456789abcdef",
          serverPublicKey: pair.publicKeyBase64,
          expiresAt: Date.now() + 300_000,
        };
        activeOffer = {
          handshakeId: unsignedOffer.handshakeId,
          serverPublicKey: unsignedOffer.serverPublicKey,
          serverPrivateKey: pair.privateKey,
        };
        return Response.json({
          ok: true,
          ttlMs: MINI_APP_SESSION_TTL_MS,
          totpEnabled: expectedAuthMode === "totp",
          authMode: expectedAuthMode,
          handshake: {
            ...unsignedOffer,
            signature: await signMiniAppHandshakeOffer(signingKey, unsignedOffer),
          },
        });
      }
      if (url.pathname === "/api/auth/login") {
        const loginReq: MiniAppEncryptedLoginRequest = JSON.parse(
          rawBody
        ) as MiniAppEncryptedLoginRequest;
        expect(activeOffer).not.toBeNull();
        expect(loginReq.handshakeId).toBe(activeOffer!.handshakeId);
        const serverDerived = await deriveServerHandshakeKeys({
          serverPrivateKey: activeOffer!.serverPrivateKey,
          handshakeId: activeOffer!.handshakeId,
          serverPublicKeyBase64: activeOffer!.serverPublicKey,
          clientPublicKeyBase64: loginReq.clientPublicKey,
        });
        expect(serverDerived).not.toBeNull();
        const plainLogin: string | null = await decryptServerText({
          cryptoKey: serverDerived!.c2sKey,
          encrypted: loginReq.encryptedPayload,
          additionalData: encodeUtf8Bytes(MINI_APP_LOGIN_REQUEST_AAD),
        });
        expect(plainLogin).not.toBeNull();
        const parsedInner: Record<string, unknown> = JSON.parse(plainLogin!) as Record<string, unknown>;
        if (expectedAuthMode === "totp") {
          expect(parsedInner).toEqual({
            handshakeId: activeOffer!.handshakeId,
            totpCode: "123456",
          });
          expect("password" in parsedInner).toBeFalse();
        } else {
          expect(parsedInner).toEqual({
            handshakeId: activeOffer!.handshakeId,
            password: "super-secret",
          });
        }
        const sealedLoginRes = await encryptServerEnvelope(
          serverDerived!.s2cKey,
          JSON.stringify({
            ok: true,
            sessionToken: issuedToken,
            sessionKey: TEST_SESSION_KEY,
            expiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
            ttlMs: MINI_APP_SESSION_TTL_MS,
          }),
          encodeUtf8Bytes(MINI_APP_LOGIN_RESPONSE_AAD)
        );
        return Response.json(sealedLoginRes);
      }
      if (url.pathname === "/api/chats/feature") {
        const sendKey: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
        const parsedReq: unknown = JSON.parse(rawBody);
        expect(isMiniAppEncryptedEnvelope(parsedReq)).toBeTrue();
        if (!isMiniAppEncryptedEnvelope(parsedReq)) {
          throw new Error("missing envelope");
        }
        const plainReq: string = await decryptMiniAppPayload(
          sendKey,
          parsedReq,
          buildMiniAppEnvelopeAad("POST", "/api/chats/feature", "req")
        );
        expect(JSON.parse(plainReq)).toEqual({
          chatId: -100,
          feature: "aiChat",
          enabled: true,
        });
        const sealedNextKey: string = await sealRotatedMiniAppSessionKey(
          sendKey,
          TEST_ROTATED_SESSION_KEY,
          rotatedToken
        );
        const encryptedRes = await encryptMiniAppEnvelope(
          sendKey,
          JSON.stringify({ ok: true, message: "FEATURE_ENABLED" }),
          buildMiniAppEnvelopeAad("POST", "/api/chats/feature", "res")
        );
        return Response.json(encryptedRes, {
          headers: {
            [MINI_APP_SESSION_HEADER]: rotatedToken,
            [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(
              Date.now() + MINI_APP_SESSION_TTL_MS
            ),
            [MINI_APP_SESSION_KEY_HEADER]: sealedNextKey,
          },
        });
      }
      if (url.pathname === "/api/gallery/upload") {
        expect(init?.body instanceof Uint8Array).toBeTrue();
        const rawBody: Uint8Array = init!.body as Uint8Array;
        expect(rawBody.byteLength).toBe(4 + 12 + 16);
        // 密文二进制帧不再以明文 PNG 魔数 0x89 0x50 0x4e 0x47 开头。
        expect(Array.from(rawBody.subarray(0, 4))).not.toEqual([
          0x89, 0x50, 0x4e, 0x47,
        ]);
        const rotKey: CryptoKey = await importMiniAppAesGcmKey(
          TEST_ROTATED_SESSION_KEY
        );
        const decryptedUploadBytes: Uint8Array<ArrayBuffer> | null =
          await decryptServerBinary({
            cryptoKey: rotKey,
            encryptedBytes: rawBody,
            additionalData: buildMiniAppEnvelopeAad(
              "POST",
              "/api/gallery/upload",
              "req"
            ),
          });
        expect(decryptedUploadBytes).toEqual(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        );
        const encryptedUploadRes = await encryptMiniAppEnvelope(
          rotKey,
          JSON.stringify({
            ok: true,
            outcome: "added",
            fileName: "hash.png",
            message: "GALLERY_IMAGE_ADDED",
          }),
          buildMiniAppEnvelopeAad("POST", "/api/gallery/upload", "res")
        );
        return Response.json(encryptedUploadRes);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }) as typeof fetch;

    await loginMiniAppWithPassword("super-secret", "password");
    expect(readMiniAppSessionToken()).toBe(issuedToken);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
    expect((await getMiniAppSessionCryptoKey())?.extractable).toBeFalse();
    expect(localStoreMap.size).toBe(0);
    const storedMetaRaw: string | undefined = sessionStoreMap.get(MINI_APP_SESSION_STORAGE_KEY);
    expect(storedMetaRaw).toBeDefined();
    expect(storedMetaRaw).not.toContain(TEST_SESSION_KEY);
    expect(Object.keys(JSON.parse(storedMetaRaw!) as Record<string, unknown>).sort()).toEqual([
      "expiresAt",
      "token",
    ]);
    for (const globalKey of [
      "__copyNinjaSessionToken",
      "__copyNinjaSessionKey",
      "__copyNinjaSessionExpiresAt",
      "__copyNinjaAssetToken",
    ]) {
      expect((globalThis as Record<string, unknown>)[globalKey]).toBeUndefined();
    }

    const toggleRes = await miniAppFetchJson<{ readonly ok: boolean }>(
      "./api/chats/feature",
      {
        method: "POST",
        body: JSON.stringify({ chatId: -100, feature: "aiChat", enabled: true }),
      }
    );
    expect(toggleRes.ok).toBeTrue();
    // 滑动续期后令牌与密钥均已轮换为新值，后续请求使用新密钥加解密。
    expect(readMiniAppSessionToken()).toBe(rotatedToken);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();

    // 核验出站请求头、查询串与请求体中绝不包含任何明文密码或 sessionKey。
    for (const rec of outboundWireRecords) {
      expect(rec.path).not.toContain("super-secret");
      expect(rec.rawBody).not.toContain("super-secret");
      expect(rec.path).not.toContain(TEST_SESSION_KEY);
      expect(rec.rawBody).not.toContain(TEST_SESSION_KEY);
      for (const headerVal of Object.values(rec.headers)) {
        expect(headerVal).not.toContain("super-secret");
        expect(headerVal).not.toContain(TEST_SESSION_KEY);
      }
    }

    // 图库二进制上传请求体保持原始字节不加密，响应经轮换后的新会话密钥解密。
    const uploadRes = await uploadMiniAppGalleryImageBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    );
    expect(uploadRes.ok).toBeTrue();
    expect(uploadRes.outcome).toBe("added");

    // 验证 #8：TOTP 模式登录内层载荷仅含 { handshakeId, totpCode }，不含冗余 password 字段。
    expectedAuthMode = "totp";
    await loginMiniAppWithPassword("123456", "totp");
    expect(readMiniAppSessionToken()).toBe(issuedToken);
    expectedAuthMode = "password";

    // 等待异步 IDB 落盘后验证页面刷新恢复流程（sessionStorage 元数据 + IndexedDB 不可导出 CryptoKey）。
    await Bun.sleep(10);
    const savedSessionJson: string = sessionStoreMap.get(MINI_APP_SESSION_STORAGE_KEY)!;
    // 仅重置内存闭包而不销毁已持久化的 sessionStorage 与 IndexedDB 夹具。
    const savedSessionStorage = (globalThis as { sessionStorage?: unknown }).sessionStorage;
    (globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    clearMiniAppSessionToken();
    await Bun.sleep(10);
    expect(readMiniAppSessionToken()).toBe("");
    (globalThis as { sessionStorage?: unknown }).sessionStorage = savedSessionStorage;
    (globalThis as { indexedDB?: unknown }).indexedDB = idbFactory;
    sessionStoreMap.set(MINI_APP_SESSION_STORAGE_KEY, savedSessionJson);
    await hydrateMiniAppSessionFromStorage();
    expect(readMiniAppSessionToken()).toBe(issuedToken);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();
    expect((await getMiniAppSessionCryptoKey())?.extractable).toBeFalse();

    // IndexedDB 中若缺失不可导出 CryptoKey，水合自毁清空 sessionStorage 并要求重新登录。
    (globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    clearMiniAppSessionToken();
    await Bun.sleep(10);
    (globalThis as { sessionStorage?: unknown }).sessionStorage = savedSessionStorage;
    (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
    sessionStoreMap.set(MINI_APP_SESSION_STORAGE_KEY, savedSessionJson);
    await hydrateMiniAppSessionFromStorage();
    expect(readMiniAppSessionToken()).toBe("");
    expect(await getMiniAppSessionCryptoKey()).toBeNull();
    expect(sessionStoreMap.has(MINI_APP_SESSION_STORAGE_KEY)).toBeFalse();

    // 若 sessionStorage 元数据含旧版明文 sessionKey 字段或不合法，水合读取即自毁清理。
    sessionStoreMap.set(
      MINI_APP_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: issuedToken,
        expiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
        sessionKey: TEST_SESSION_KEY,
      })
    );
    await hydrateMiniAppSessionFromStorage();
    expect(readMiniAppSessionToken()).toBe("");
    expect(sessionStoreMap.has(MINI_APP_SESSION_STORAGE_KEY)).toBeFalse();

    // 若服务端 precheck 未下发有效签名握手或 /api/auth/login 返回未加密明文 JSON，前端必须严格拒绝。
    globalThis.fetch = (async (): Promise<Response> =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: {
          handshakeId: "bad",
          serverPublicKey: "not-base64",
          expiresAt: Date.now() + 60_000,
          signature: "bad",
        },
      })) as unknown as typeof fetch;
    await expect(
      loginMiniAppWithPassword("super-secret", "password")
    ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0]
    ): Promise<Response> => {
      const url: URL = new URL(String(input), "https://mini.test/");
      if (url.pathname === "/api/auth/precheck") {
        const pair = await generateServerX25519KeyPair();
        const signingKey: CryptoKey = TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey;
        const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
          handshakeId: "fedcba9876543210fedcba9876543210",
          serverPublicKey: pair.publicKeyBase64,
          expiresAt: Date.now() + 60_000,
        };
        return Response.json({
          ok: true,
          ttlMs: MINI_APP_SESSION_TTL_MS,
          totpEnabled: false,
          authMode: "password",
          handshake: {
            ...unsignedOffer,
            signature: await signMiniAppHandshakeOffer(signingKey, unsignedOffer),
          },
        });
      }
      return Response.json({
        ok: true,
        sessionToken: issuedToken,
        sessionKey: TEST_SESSION_KEY,
        expiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
        ttlMs: MINI_APP_SESSION_TTL_MS,
      });
    }) as typeof fetch;
    await expect(
      loginMiniAppWithPassword("super-secret", "password")
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    setMiniAppSessionToken(issuedToken, Date.now() + 60_000, TEST_SESSION_KEY);
    clearMiniAppSessionToken();
  });

  test("登录响应上的明文 403 INVALID_PASSWORD / INVALID_TOTP_CODE 凭据裁决降级一律拒绝", async () => {
    const installSignedPrecheckAndPlainLogin = (plainBody: unknown, status: number): void => {
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0]
      ): Promise<Response> => {
        const url: URL = new URL(String(input), "https://mini.test/");
        if (url.pathname === "/api/auth/precheck") {
          const pair = await generateServerX25519KeyPair();
          const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
            handshakeId: "00112233445566778899aabbccddeeff",
            serverPublicKey: pair.publicKeyBase64,
            expiresAt: Date.now() + 60_000,
          };
          return Response.json({
            ok: true,
            ttlMs: MINI_APP_SESSION_TTL_MS,
            totpEnabled: false,
            authMode: "password",
            handshake: {
              ...unsignedOffer,
              signature: await signMiniAppHandshakeOffer(
                TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey,
                unsignedOffer
              ),
            },
          });
        }
        return Response.json(plainBody, { status });
      }) as typeof fetch;
    };

    // #6：服务端只以密文下发凭据裁决，明文 403 INVALID_PASSWORD / INVALID_TOTP_CODE 降级一律拒绝。
    for (const downgradeCase of [
      {
        status: 403,
        body: { ok: false, status: 403, code: "INVALID_PASSWORD", error: "INVALID_PASSWORD", remainingAttempts: 2 },
      },
      {
        status: 403,
        body: { ok: false, status: 403, code: "INVALID_TOTP_CODE", error: "INVALID_TOTP_CODE", remainingAttempts: 1 },
      },
    ]) {
      clearPendingMiniAppAuthHandshake();
      installSignedPrecheckAndPlainLogin(downgradeCase.body, downgradeCase.status);
      await expect(
        loginMiniAppWithPassword("correct-password", "password")
      ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    }
  });

  test("本地无会话密钥时拒绝明文发送已认证 POST 请求体并触发重新解锁", async () => {
    seedTestMiniAppSession("3".repeat(64), Date.now() + 60_000);
    clearMiniAppSessionToken();
    let networkCalled: boolean = false;
    globalThis.fetch = (async (): Promise<Response> => {
      networkCalled = true;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await expect(
      miniAppFetchJson("./api/configs/restart", {
        method: "POST",
        body: JSON.stringify({}),
      })
    ).rejects.toThrow("[PASSWORD_REQUIRED]");
    expect(networkCalled).toBeFalse();
  });

  test("URL 查询串 AEAD 封装：线上传输仅携带 ?e=、跨路由/跨方法 AAD 失配拒绝解封，缺失会话密钥时阻断带参 GET 并清空会话", async () => {
    expect(resolveCanonicalMiniAppApiPath("./api/configs/file")).toBe("/api/configs/file");
    expect(resolveCanonicalMiniAppApiPath("/api/identities/whitelist")).toBe(
      "/api/identities/whitelist"
    );
    expect(
      resolveCanonicalMiniAppApiPath("/subpath/api/chats/messages?chatId=-1001&page=1#top")
    ).toBe("/api/chats/messages");
    expect(resolveCanonicalMiniAppApiPath("api/picker/result")).toBe("/api/picker/result");
    expect(resolveCanonicalMiniAppApiPath("./health")).toBe("/health");

    const key: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
    const sealedConfigQuery: string = await sealMiniAppQuery(
      key,
      "scope=dynamic&fileName=ad_detect.json",
      "GET /api/configs/file"
    );
    expect(
      await unsealMiniAppQuery(key, sealedConfigQuery, "GET /api/configs/file")
    ).toBe("scope=dynamic&fileName=ad_detect.json");

    // 跨路由 AAD 失配（GET /api/gallery 与 GET /api/configs/file）或跨 HTTP 方法失配均拒绝解封。
    await expect(
      unsealMiniAppQuery(key, sealedConfigQuery, "GET /api/gallery")
    ).resolves.toBeNull();
    await expect(
      unsealMiniAppQuery(key, sealedConfigQuery, "POST /api/configs/file")
    ).resolves.toBeNull();

    // 空查询、空 AAD、超长查询被前端拒绝；空白字符与畸形口令被服务端返回 null，空密文仅解出空串由中间件拦下。
    await expect(sealMiniAppQuery(key, "", "GET /api/gallery")).rejects.toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    await expect(sealMiniAppQuery(key, "page=1", "")).rejects.toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    await expect(
      sealMiniAppQuery(
        key,
        "q=" + "x".repeat(MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH),
        "GET /api/gallery"
      )
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    await expect(unsealMiniAppQuery(key, "", "GET /api/gallery")).resolves.toBeNull();
    await expect(
      unsealMiniAppQuery(
        key,
        "a".repeat(MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH + 1),
        "GET /api/gallery"
      )
    ).resolves.toBeNull();
    await expect(
      unsealMiniAppQuery(key, `${sealedConfigQuery} `, "GET /api/configs/file")
    ).resolves.toBeNull();
    const emptyPlainEncrypted = await encryptMiniAppPayload(
      key,
      "",
      encodeUtf8Bytes("GET /api/gallery")
    );
    await expect(
      unsealMiniAppQuery(
        key,
        `${emptyPlainEncrypted.iv}.${emptyPlainEncrypted.payload}`,
        "GET /api/gallery"
      )
    ).resolves.toBe("");

    // 真实 miniAppFetchJson 出站线级校验：原始 fetch URL 仅含 ?e=...，绝不出现明文参数名或参数值。
    seedTestMiniAppSession("5".repeat(64), Date.now() + 60_000, TEST_SESSION_KEY);
    const rawFetchInputs: string[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const rawUrlText: string = String(input);
      rawFetchInputs.push(rawUrlText);
      const parsedUrl: URL = new URL(rawUrlText, "https://mini.test/");
      const method: string = (init?.method ?? "GET").toUpperCase();
      expect(Array.from(parsedUrl.searchParams.keys())).toEqual(
        parsedUrl.search.length > 0 ? [MINI_APP_ENCRYPTED_QUERY_PARAM] : []
      );
      if (parsedUrl.search.length > 0) {
        const plainQuery: string = (await unsealMiniAppQuery(
          key,
          parsedUrl.searchParams.get(MINI_APP_ENCRYPTED_QUERY_PARAM) ?? "",
          `${method} ${resolveCanonicalMiniAppApiPath(parsedUrl.pathname)}`
        ))!;
        const recoveredParams: URLSearchParams = new URLSearchParams(plainQuery);
        if (parsedUrl.pathname === "/api/configs/file") {
          expect(recoveredParams.get("scope")).toBe("dynamic");
          expect(recoveredParams.get("fileName")).toBe("ad_detect.json");
        } else if (parsedUrl.pathname === "/api/identities/whitelist") {
          expect(recoveredParams.get("page")).toBe("2");
          expect(recoveredParams.get("pageSize")).toBe("15");
          expect(recoveredParams.get("q")).toBe("alice");
        } else if (parsedUrl.pathname === "/subpath/api/chats/messages") {
          expect(recoveredParams.get("chatId")).toBe("-1001");
          expect(recoveredParams.get("page")).toBe("1");
          expect(recoveredParams.get("pageSize")).toBe("10");
        }
      }
      const resEnvelope = await encryptMiniAppEnvelope(
        key,
        JSON.stringify({ ok: true }),
        buildMiniAppEnvelopeAad(method, resolveCanonicalMiniAppApiPath(parsedUrl.pathname), "res")
      );
      return Response.json(resEnvelope);
    }) as typeof fetch;

    await miniAppFetchJson(
      "./api/configs/file?scope=dynamic&fileName=ad_detect.json"
    );
    await miniAppFetchJson(
      "./api/identities/whitelist?page=2&pageSize=15&q=alice"
    );
    await miniAppFetchJson(
      "/subpath/api/chats/messages?chatId=-1001&page=1&pageSize=10#anchor"
    );
    await miniAppFetchJson("./api/status?");

    expect(rawFetchInputs).toHaveLength(4);
    for (const wireUrl of rawFetchInputs) {
      expect(wireUrl).not.toContain("ad_detect.json");
      expect(wireUrl).not.toContain("dynamic");
      expect(wireUrl).not.toContain("alice");
      expect(wireUrl).not.toContain("pageSize");
    }
    expect(rawFetchInputs[2]?.endsWith("#anchor")).toBeTrue();
    expect(rawFetchInputs[3]).toBe("./api/status");

    // 缺失会话密钥时，带查询串的已认证 GET 立即清除本地会话并抛出 [PASSWORD_REQUIRED]，绝不发出明文网络请求。
    clearMiniAppSessionToken();
    let leakedNetworkCall: boolean = false;
    globalThis.fetch = (async (): Promise<Response> => {
      leakedNetworkCall = true;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await expect(
      miniAppFetchJson("./api/configs/file?scope=dynamic&fileName=ad_detect.json")
    ).rejects.toThrow("[PASSWORD_REQUIRED]");
    expect(leakedNetworkCall).toBeFalse();
    expect(readMiniAppSessionToken()).toBe("");
    expect(hasMiniAppSessionCryptoKey()).toBeFalse();
  });
});
