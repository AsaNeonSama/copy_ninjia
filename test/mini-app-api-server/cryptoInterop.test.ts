/**
 * Mini App 前后端 `libs/crypto.ts` 与 TLS 模式 ECDH 握手（`libs/handshakeCrypto.ts`）真实跨端互通与负例拒绝矩阵测试：
 * 1. 验证前端真实实现加密的信封、加密查询参数（`?e=`）与源站 Ed25519 + 临时 X25519 ECDH + HKDF-SHA256 登录握手可由服务端真实实现验签与解密；
 * 2. 验证服务端真实实现签发的临时公钥握手凭据、登录响应与滑动续期轮换密钥响应头（`X-Mini-App-Session-Key`）可由前端真实实现验签与解封；
 * 3. 验证篡改密文/IV/认证标签/签名/公钥、错配 AAD、空串、非对称点号、空白字符及信封多余键在两端统一被严格拒绝。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
} from "../../packages/consts/miniAppCrypto";
import { MINI_APP_AES_GCM_TAG_BYTES } from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import {
  decryptMiniAppBinary as serverDecryptBinary,
  decryptMiniAppText as serverDecryptText,
  encryptMiniAppEnvelope as serverEncryptEnvelope,
  importMiniAppAesGcmKey as serverImportKey,
  parseMiniAppEncryptedEnvelope as serverParseEnvelope,
  parseMiniAppEncryptedPayload as serverParsePayload,
  sealRotatedMiniAppSessionKey as serverSealRotatedSessionKey,
  unsealMiniAppQuery as serverUnsealQuery,
} from "../../packages/mini-app-api-server/libs/crypto";
import {
  deriveMiniAppHandshakeKeys as serverDeriveHandshakeKeys,
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair as serverGenerateX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../../packages/mini-app-api-server/libs/handshakeCrypto";
import {
  base64ToBytes as frontendBase64ToBytes,
  buildMiniAppEnvelopeAad as frontendBuildEnvelopeAad,
  bytesToBase64 as frontendBytesToBase64,
  decryptMiniAppPayload as frontendDecryptPayload,
  encodeUtf8Bytes as frontendEncodeUtf8Bytes,
  encryptMiniAppBinary as frontendEncryptBinary,
  encryptMiniAppEnvelope as frontendEncryptEnvelope,
  encryptMiniAppPayload as frontendEncryptPayload,
  importMiniAppAesGcmKey as frontendImportKey,
  isMiniAppEncryptedEnvelope as frontendIsEnvelope,
  sealMiniAppQuery as frontendSealQuery,
  unsealRotatedSessionKey as frontendUnsealRotatedSessionKey,
} from "../../packages/mini-app-frontend/libs/crypto";
import {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} from "../../packages/mini-app-frontend/libs/handshakeCrypto";
import { setMiniAppServerSigningPublicKeyForTest } from "../../packages/mini-app-frontend/libs/signingKey";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../../packages/types/miniApp/configs";

const SESSION_KEY_HEX: string = "0123456789abcdef".repeat(4);
const ROTATED_KEY_HEX: string = "fedcba9876543210".repeat(4);
const SESSION_TOKEN: string = "a".repeat(64);
const NEXT_SESSION_TOKEN: string = "b".repeat(64);

afterEach((): void => {
  setMiniAppServerSigningPublicKeyForTest(null);
});

/**
 * 翻转 Base64 密文首字节以构造被篡改但长度不变的 Base64 字符串。
 *
 * @param base64 原始标准 Base64 字符串
 * @returns 首字节按位取反后的标准 Base64 字符串
 */
function flipFirstBase64Byte(base64: string): string {
  const bytes: Uint8Array = Uint8Array.fromBase64(base64);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toBase64();
}

describe("Mini App 前后端 libs/crypto 跨端互通与负例矩阵", () => {
  test("传输信封双向互通：前端封装 -> 服务端验真解密，服务端封装 -> 前端验真解密", async (): Promise<void> => {
    const clientKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);
    const serverKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const sampleJson: string = JSON.stringify({
      ok: true,
      chatId: -100123,
      message: "杂鱼♡跨端互通测试",
      items: [1, false, null],
    });

    const clientEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await frontendEncryptEnvelope(clientKey, sampleJson);
    expect(frontendIsEnvelope(clientEnvelope)).toBeTrue();
    const parsedByServer: Readonly<MiniAppEncryptedEnvelope> | null =
      serverParseEnvelope(JSON.parse(JSON.stringify(clientEnvelope)));
    expect(parsedByServer).not.toBeNull();
    expect(
      await serverDecryptText({
        cryptoKey: serverKey,
        encrypted: parsedByServer!,
      })
    ).toBe(sampleJson);

    const serverEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await serverEncryptEnvelope(serverKey, sampleJson);
    const parsedByClient: unknown = JSON.parse(JSON.stringify(serverEnvelope));
    expect(frontendIsEnvelope(parsedByClient)).toBeTrue();
    if (!frontendIsEnvelope(parsedByClient)) {
      throw new Error("Expected frontendIsEnvelope to accept server envelope.");
    }
    expect(await frontendDecryptPayload(clientKey, parsedByClient)).toBe(sampleJson);
  });

  test("TLS 模式 Ed25519 验签 + X25519 ECDH + HKDF-SHA256 双向互通且强绑定方向标签与请求响应 AAD", async (): Promise<void> => {
    const runtimeSigningKey = await generateMiniAppEd25519KeyPair();
    setMiniAppServerSigningPublicKeyForTest(runtimeSigningKey.publicKeyBase64);
    const signingKey: CryptoKey = runtimeSigningKey.privateKey;
    const serverX25519 = await serverGenerateX25519KeyPair();
    const handshakeId: string = "0123456789abcdef0123456789abcdef";
    const expiresAt: number = Date.now() + 300_000;
    const signature: string = await signMiniAppHandshakeOffer(signingKey, {
      handshakeId,
      serverPublicKey: serverX25519.publicKeyBase64,
      expiresAt,
    });
    const offer = {
      handshakeId,
      serverPublicKey: serverX25519.publicKeyBase64,
      expiresAt,
      signature,
    };
    expect(await verifyMiniAppHandshakeOfferDetailed(offer)).toEqual({ ok: true, offer });
    expect(
      (await verifyMiniAppHandshakeOfferDetailed({
        ...offer,
        expiresAt: expiresAt + 1,
      })).ok
    ).toBeFalse();

    const clientX25519 = await generateClientMiniAppX25519KeyPair();
    const clientDerived = await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: clientX25519.privateKey,
      serverPublicKeyBase64: serverX25519.publicKeyBase64,
      clientPublicKeyBase64: clientX25519.publicKeyBase64,
      handshakeId,
    });
    const serverDerived = await serverDeriveHandshakeKeys({
      serverPrivateKey: serverX25519.privateKey,
      handshakeId,
      serverPublicKeyBase64: serverX25519.publicKeyBase64,
      clientPublicKeyBase64: clientX25519.publicKeyBase64,
    });
    expect(serverDerived).not.toBeNull();

    const reqPlain: string = JSON.stringify({
      handshakeId,
      password: "secret-password-123456",
    });
    const clientReqPayload: Readonly<MiniAppEncryptedPayload> =
      await frontendEncryptPayload(
        clientDerived.c2sKey,
        reqPlain,
        frontendEncodeUtf8Bytes(MINI_APP_LOGIN_REQUEST_AAD)
      );
    const parsedReq: Readonly<MiniAppEncryptedPayload> | null =
      serverParsePayload(JSON.parse(JSON.stringify(clientReqPayload)));
    expect(parsedReq).not.toBeNull();
    expect(
      await serverDecryptText({
        cryptoKey: serverDerived!.c2sKey,
        encrypted: parsedReq!,
        additionalData: new TextEncoder().encode(MINI_APP_LOGIN_REQUEST_AAD),
      })
    ).toBe(reqPlain);
    // c2sKey 与 s2cKey 方向隔离且响应 AAD 不匹配请求方向。
    expect(
      await serverDecryptText({
        cryptoKey: serverDerived!.c2sKey,
        encrypted: parsedReq!,
        additionalData: new TextEncoder().encode(MINI_APP_LOGIN_RESPONSE_AAD),
      })
    ).toBeNull();

    const resPlain: string = JSON.stringify({
      ok: true,
      sessionToken: SESSION_TOKEN,
      sessionKey: SESSION_KEY_HEX,
      expiresAt,
      ttlMs: 300_000,
    });
    const serverResEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await serverEncryptEnvelope(
        serverDerived!.s2cKey,
        resPlain,
        new TextEncoder().encode(MINI_APP_LOGIN_RESPONSE_AAD)
      );
    expect(
      await frontendDecryptPayload(
        clientDerived.s2cKey,
        serverResEnvelope,
        frontendEncodeUtf8Bytes(MINI_APP_LOGIN_RESPONSE_AAD)
      )
    ).toBe(resPlain);
    await expect(
      frontendDecryptPayload(
        clientDerived.s2cKey,
        serverResEnvelope,
        frontendEncodeUtf8Bytes(MINI_APP_LOGIN_REQUEST_AAD)
      )
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  });

  test("滑动续期轮换密钥头互通：服务端封 -> 前端解，新会话令牌 AAD 不匹配时拒绝", async (): Promise<void> => {
    const serverOldKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const clientOldKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);

    const headerValue: string = await serverSealRotatedSessionKey(
      serverOldKey,
      ROTATED_KEY_HEX,
      NEXT_SESSION_TOKEN
    );
    expect(
      await frontendUnsealRotatedSessionKey(
        clientOldKey,
        headerValue,
        NEXT_SESSION_TOKEN
      )
    ).toBe(ROTATED_KEY_HEX);
    await expect(
      frontendUnsealRotatedSessionKey(clientOldKey, headerValue, SESSION_TOKEN)
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
  });

  test("加密查询参数互通：前端 sealMiniAppQuery -> 服务端 unsealMiniAppQuery，错配路由/方法 AAD 返回 null", async (): Promise<void> => {
    const clientKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);
    const serverKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const rawQuery: string = "chatId=-1001&page=2&q=%E6%9D%82%E9%B1%BC";

    const sealedQuery: string = await frontendSealQuery(
      clientKey,
      rawQuery,
      "GET /api/chats/messages"
    );
    expect(
      await serverUnsealQuery(serverKey, sealedQuery, "GET /api/chats/messages")
    ).toBe(rawQuery);
    expect(
      await serverUnsealQuery(serverKey, sealedQuery, "POST /api/chats/messages")
    ).toBeNull();
    expect(
      await serverUnsealQuery(serverKey, sealedQuery, "GET /api/chats/detail")
    ).toBeNull();
  });

  test("负例矩阵：篡改密文/IV/认证标签、空串、信封多余键与含空白字符在两端均一律拒绝", async (): Promise<void> => {
    const clientKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);
    const serverKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const clientEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await frontendEncryptEnvelope(clientKey, JSON.stringify({ check: "tamper" }));
    const serverEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await serverEncryptEnvelope(serverKey, JSON.stringify({ check: "tamper" }));

    // 1. 篡改密文、IV 或认证标签尾字节，两端各自解密对端产物均失败。
    const tamperedServerCipher: string = flipFirstBase64Byte(serverEnvelope.payload);
    const tamperedServerIv: string = flipFirstBase64Byte(serverEnvelope.iv);
    await expect(
      frontendDecryptPayload(clientKey, {
        iv: serverEnvelope.iv,
        payload: tamperedServerCipher,
      })
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    await expect(
      frontendDecryptPayload(clientKey, {
        iv: tamperedServerIv,
        payload: serverEnvelope.payload,
      })
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);

    const clientCipherBytes: Uint8Array = frontendBase64ToBytes(clientEnvelope.payload);
    expect(clientCipherBytes.byteLength).toBeGreaterThanOrEqual(MINI_APP_AES_GCM_TAG_BYTES);
    clientCipherBytes[clientCipherBytes.byteLength - 1] =
      (clientCipherBytes[clientCipherBytes.byteLength - 1] ?? 0) ^ 0xff;
    expect(
      await serverDecryptText({
        cryptoKey: serverKey,
        encrypted: {
          iv: clientEnvelope.iv,
          payload: frontendBytesToBase64(clientCipherBytes),
        },
      })
    ).toBeNull();

    const shortIv: string = frontendBytesToBase64(new Uint8Array(MINI_APP_AES_GCM_IV_BYTES - 1));
    await expect(
      frontendDecryptPayload(clientKey, { iv: shortIv, payload: serverEnvelope.payload })
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    expect(
      await serverDecryptText({
        cryptoKey: serverKey,
        encrypted: { iv: shortIv, payload: clientEnvelope.payload },
      })
    ).toBeNull();

    // 2. 空串严格拒绝。
    expect((): Uint8Array => frontendBase64ToBytes("")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    expect((): Uint8Array => frontendBase64ToBytes("   ")).toThrow(
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE
    );
    await expect(
      frontendDecryptPayload(clientKey, { iv: "", payload: serverEnvelope.payload })
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
    expect(
      await serverDecryptText({
        cryptoKey: serverKey,
        encrypted: { iv: "", payload: clientEnvelope.payload },
      })
    ).toBeNull();
    expect(await serverUnsealQuery(serverKey, "", "GET /api/chats")).toBeNull();
    await expect(
      frontendSealQuery(clientKey, "", "GET /api/chats")
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);

    // 3. 信封多余键与含空白字符在两端均被严格拒绝。
    const extraKeyEnvelope: Record<string, unknown> = {
      ...serverEnvelope,
      extra: true,
    };
    expect(frontendIsEnvelope(extraKeyEnvelope)).toBeFalse();
    expect(serverParseEnvelope(extraKeyEnvelope)).toBeNull();

    const whitespaceIvEnvelope: Record<string, unknown> = {
      encrypted: true,
      iv: ` ${serverEnvelope.iv}`,
      payload: serverEnvelope.payload,
    };
    const whitespacePayloadEnvelope: Record<string, unknown> = {
      encrypted: true,
      iv: serverEnvelope.iv,
      payload: `${serverEnvelope.payload}\n`,
    };
    expect(frontendIsEnvelope(whitespaceIvEnvelope)).toBeFalse();
    expect(serverParseEnvelope(whitespaceIvEnvelope)).toBeNull();
    expect(frontendIsEnvelope(whitespacePayloadEnvelope)).toBeFalse();
    expect(serverParseEnvelope(whitespacePayloadEnvelope)).toBeNull();
  });

  test("二进制上传帧跨端互通与负例：前端 encryptMiniAppBinary -> 服务端 decryptMiniAppBinary，截断/篡改/错密钥/错 AAD 一律拒绝", async (): Promise<void> => {
    const clientKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);
    const serverKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const wrongServerKey: CryptoKey = await serverImportKey(ROTATED_KEY_HEX);
    const uploadAad: Uint8Array<ArrayBuffer> = frontendBuildEnvelopeAad(
      "POST",
      "/api/gallery/upload",
      "req"
    );

    const pngHeaderBytes: Uint8Array<ArrayBuffer> = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const encryptedPngFrame: Uint8Array<ArrayBuffer> = await frontendEncryptBinary(
      clientKey,
      pngHeaderBytes,
      uploadAad
    );
    expect(encryptedPngFrame.byteLength).toBe(
      pngHeaderBytes.byteLength + MINI_APP_AES_GCM_IV_BYTES + MINI_APP_AES_GCM_TAG_BYTES
    );
    expect(
      await serverDecryptBinary({
        cryptoKey: serverKey,
        encryptedBytes: encryptedPngFrame,
        additionalData: uploadAad,
      })
    ).toEqual(pngHeaderBytes);

    // 0 字节空二进制载荷同样能端到端加密与解密，并绑定严格 AAD。
    const emptyFrame: Uint8Array<ArrayBuffer> = await frontendEncryptBinary(
      clientKey,
      new Uint8Array(0),
      uploadAad
    );
    expect(emptyFrame.byteLength).toBe(
      MINI_APP_AES_GCM_IV_BYTES + MINI_APP_AES_GCM_TAG_BYTES
    );
    expect(
      await serverDecryptBinary({
        cryptoKey: serverKey,
        encryptedBytes: emptyFrame,
        additionalData: uploadAad,
      })
    ).toEqual(new Uint8Array(0));

    // 错密钥、错 AAD、截断、篡改 IV/密文/标签均返回 null。
    expect(
      await serverDecryptBinary({
        cryptoKey: wrongServerKey,
        encryptedBytes: encryptedPngFrame,
        additionalData: uploadAad,
      })
    ).toBeNull();
    expect(
      await serverDecryptBinary({
        cryptoKey: serverKey,
        encryptedBytes: encryptedPngFrame,
        additionalData: frontendBuildEnvelopeAad("POST", "/api/gallery/upload", "res"),
      })
    ).toBeNull();
    expect(
      await serverDecryptBinary({
        cryptoKey: serverKey,
        encryptedBytes: encryptedPngFrame.subarray(
          0,
          MINI_APP_AES_GCM_IV_BYTES + MINI_APP_AES_GCM_TAG_BYTES - 1
        ),
        additionalData: uploadAad,
      })
    ).toBeNull();
    for (const offset of [0, encryptedPngFrame.byteLength - 1]) {
      const tampered: Uint8Array = new Uint8Array(encryptedPngFrame);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0xff;
      expect(
        await serverDecryptBinary({
          cryptoKey: serverKey,
          encryptedBytes: tampered,
          additionalData: uploadAad,
        })
      ).toBeNull();
    }
  });

  test("无 AAD（additionalData 为 undefined）在固定 IV 下与省略 additionalData 的原生 AES-GCM 密文逐字节一致，且仍拒绝错误 AAD", async (): Promise<void> => {
    const clientKey: CryptoKey = await frontendImportKey(SESSION_KEY_HEX);
    const serverKey: CryptoKey = await serverImportKey(SESSION_KEY_HEX);
    const fixedIv: Uint8Array<ArrayBuffer> = new Uint8Array(MINI_APP_AES_GCM_IV_BYTES);
    for (let index: number = 0; index < fixedIv.byteLength; index += 1) {
      fixedIv[index] = index + 1;
    }
    const plainText: string = JSON.stringify({ ok: true, label: "fixed-iv-no-aad" });
    const plainBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(plainText);
    const referenceCipher: Uint8Array<ArrayBuffer> = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: fixedIv,
          tagLength: MINI_APP_AES_GCM_TAG_BITS,
        },
        serverKey,
        plainBytes
      )
    );
    const expectedIvBase64: string = fixedIv.toBase64();
    const expectedPayloadBase64: string = referenceCipher.toBase64();
    const expectedBinaryFrame: Uint8Array<ArrayBuffer> = new Uint8Array(
      MINI_APP_AES_GCM_IV_BYTES + referenceCipher.byteLength
    );
    expectedBinaryFrame.set(fixedIv, 0);
    expectedBinaryFrame.set(referenceCipher, MINI_APP_AES_GCM_IV_BYTES);

    const randomValuesSpy = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(target: T): T => {
        if (target !== null) {
          new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(fixedIv);
        }
        return target;
      }
    );
    try {
      const serverEnvelope: Readonly<MiniAppEncryptedEnvelope> =
        await serverEncryptEnvelope(serverKey, plainText);
      const frontendEnvelope: Readonly<MiniAppEncryptedEnvelope> =
        await frontendEncryptEnvelope(clientKey, plainText);
      expect(serverEnvelope.iv).toBe(expectedIvBase64);
      expect(serverEnvelope.payload).toBe(expectedPayloadBase64);
      expect(frontendEnvelope).toEqual(serverEnvelope);

      const frontendBinaryFrame: Uint8Array<ArrayBuffer> =
        await frontendEncryptBinary(clientKey, plainBytes);
      expect(frontendBinaryFrame).toEqual(expectedBinaryFrame);

      expect(
        await serverDecryptText({
          cryptoKey: serverKey,
          encrypted: frontendEnvelope,
          additionalData: undefined,
        })
      ).toBe(plainText);
      expect(
        await frontendDecryptPayload(clientKey, serverEnvelope, undefined)
      ).toBe(plainText);
      expect(
        await serverDecryptBinary({
          cryptoKey: serverKey,
          encryptedBytes: frontendBinaryFrame,
          additionalData: undefined,
        })
      ).toEqual(plainBytes);

      const wrongAad: Uint8Array<ArrayBuffer> = frontendEncodeUtf8Bytes("unexpected-aad");
      expect(
        await serverDecryptText({
          cryptoKey: serverKey,
          encrypted: frontendEnvelope,
          additionalData: wrongAad,
        })
      ).toBeNull();
      await expect(
        frontendDecryptPayload(clientKey, serverEnvelope, wrongAad)
      ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);
      expect(
        await serverDecryptBinary({
          cryptoKey: serverKey,
          encryptedBytes: frontendBinaryFrame,
          additionalData: wrongAad,
        })
      ).toBeNull();
    } finally {
      randomValuesSpy.mockRestore();
    }
  });
});
