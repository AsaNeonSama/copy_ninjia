/**
 * Mini App 前端单测共用的 256-bit AES-256-GCM 会话加密传输、TLS 模式临时 ECDH 登录握手（Ed25519 签名 + X25519 + HKDF）、
 * IndexedDB `CryptoKey` 内存替身与续期封装辅助工具：
 * 1. 提供确定性的测试会话密钥对（`TEST_SESSION_KEY`、`TEST_ROTATED_SESSION_KEY`）与内存中动态生成的测试源站 Ed25519 密钥对（`TEST_RUNTIME_SIGNING_KEY_PAIR`）；
 * 2. 在 `wrapEncryptedTestFetch` 中自动通过 `setMiniAppServerSigningPublicKeyForTest` 注入测试公钥，为 `GET /api/auth/precheck` 按需签发已签名的临时 X25519 握手公钥，
 *    并对 `POST /api/auth/login` 自动执行服务端 X25519/HKDF 请求解密与响应 `s2cKey` 信封加密（保留下游明文路由测试回调写法）；
 * 3. 对已认证 JSON 路由自动断言并解密非空 URL 查询参数 `?e=`（校验唯一参数名与 `"${method} ${routePath}"` AEAD 附加认证数据）与绑定 `:req` AAD 的非空 `MiniAppEncryptedEnvelope` 请求体；
 * 4. 对模拟服务端返回的 JSON 响应自动封装为绑定 `:res` AAD 的 `MiniAppEncryptedEnvelope`，并在携带刷新 `X-Mini-App-Session` 时自动封装 `X-Mini-App-Session-Key`。
 */

import { MINI_APP_SESSION_HEADER } from "../../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_PARAM,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_HANDSHAKE_ID_HEX_PATTERN,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
  MINI_APP_SESSION_KEY_HEADER,
} from "../../../packages/mini-app-frontend/consts/miniAppCrypto";
import { resolveCanonicalMiniAppApiPath } from "../../../packages/mini-app-frontend/api/request";
import { setMiniAppSessionToken } from "../../../packages/mini-app-frontend/libs/credentials";
import { setMiniAppServerSigningPublicKeyForTest } from "../../../packages/mini-app-frontend/libs/signingKey";
import { asPayloadRecord } from "../../../packages/mini-app-frontend/libs/record";
import type {
  MiniAppIdbDatabaseLike,
  MiniAppIdbFactoryLike,
  MiniAppIdbObjectStoreLike,
  MiniAppIdbRequestLike,
  MiniAppIdbTransactionLike,
} from "../../../packages/mini-app-frontend/types/miniApp";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppEncryptedPayload,
} from "../../../packages/mini-app-frontend/types/miniAppConfigs";
import {
  buildMiniAppEnvelopeAad,
  decryptMiniAppBinary,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  generateMiniAppRandomHex,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
  parseMiniAppEncryptedPayload,
  sealRotatedMiniAppSessionKey,
  unsealMiniAppQuery,
} from "../../../packages/mini-app-api-server/libs/crypto";
import {
  deriveMiniAppHandshakeKeys,
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../../../packages/mini-app-api-server/libs/handshakeCrypto";
import type { DerivedMiniAppHandshakeKeys } from "../../../packages/mini-app-api-server/libs/handshakeCrypto";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppRuntimeSigningKeyPair,
} from "../../../packages/types/miniApp/auth";

/** 单测默认使用的 256-bit（64 位小写十六进制）会话临时加密密钥。 */
export const TEST_SESSION_KEY: string = "0123456789abcdef".repeat(4);

/** 单测模拟滑动续期轮换时签发的第二把 256-bit 会话临时加密密钥。 */
export const TEST_ROTATED_SESSION_KEY: string = "fedcba9876543210".repeat(4);

/** 前端单测模拟源站每次测试运行在内存中生成的 Ed25519 签名密钥对。 */
export const TEST_RUNTIME_SIGNING_KEY_PAIR: Readonly<MiniAppRuntimeSigningKeyPair> =
  await generateMiniAppEd25519KeyPair();

const UTF8_ENCODER: TextEncoder = new TextEncoder();
const LOGIN_REQUEST_AAD_BYTES: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
  MINI_APP_LOGIN_REQUEST_AAD
);
const LOGIN_RESPONSE_AAD_BYTES: Uint8Array<ArrayBuffer> = UTF8_ENCODER.encode(
  MINI_APP_LOGIN_RESPONSE_AAD
);
const TEST_HANDSHAKE_TTL_MS: number = 5 * 60_000;

interface IssuedMockHandshake {
  readonly serverPrivateKey: CryptoKey;
  readonly serverPublicKey: string;
  readonly expiresAt: number;
}

const testCryptoKeyCache: Map<string, Promise<CryptoKey>> = new Map<
  string,
  Promise<CryptoKey>
>();

/** 模拟服务端测持有的会话令牌 -> 256-bit 十六进制密钥映射表（避免测试包装器直接读取前端内存）。 */
const mockServerSessionKeys: Map<string, string> = new Map<string, string>();

/**
 * 构造符合 `MiniAppIdbFactoryLike` 接口的内存 IndexedDB 替身，供前端单元测试验证跨刷新 `CryptoKey` 水合与清除逻辑。
 * @returns 可挂载到 `(globalThis as TelegramWindow).indexedDB` 的内存替身工厂。
 */
export function createInMemoryIdbFactory(): Readonly<MiniAppIdbFactoryLike> {
  const databases: Map<string, Map<string, Map<string, unknown>>> = new Map<
    string,
    Map<string, Map<string, unknown>>
  >();

  return {
    open(name: string): MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> {
      let stores: Map<string, Map<string, unknown>> | undefined = databases.get(name);
      const needsUpgrade: boolean = stores === undefined;
      if (stores === undefined) {
        stores = new Map<string, Map<string, unknown>>();
        databases.set(name, stores);
      }
      const dbStores: Map<string, Map<string, unknown>> = stores;

      const db: MiniAppIdbDatabaseLike = {
        objectStoreNames: {
          contains: (storeName: string): boolean => dbStores.has(storeName),
        },
        createObjectStore: (storeName: string): unknown => {
          if (!dbStores.has(storeName)) {
            dbStores.set(storeName, new Map());
          }
          return undefined;
        },
        transaction: (storeName: string): MiniAppIdbTransactionLike => {
          const tx: MiniAppIdbTransactionLike = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: (): MiniAppIdbObjectStoreLike => {
              const targetStore: Map<string, unknown> =
                dbStores.get(storeName) ?? new Map<string, unknown>();
              dbStores.set(storeName, targetStore);
              const schedule = <T>(compute: () => T): MiniAppIdbRequestLike<T> => {
                const req: {
                  result?: T;
                  error?: unknown;
                  onsuccess: ((event?: unknown) => void) | null;
                  onerror: ((event?: unknown) => void) | null;
                } = {
                  onsuccess: null,
                  onerror: null,
                };
                queueMicrotask((): void => {
                  req.result = compute();
                  req.onsuccess?.();
                  tx.oncomplete?.();
                });
                return req;
              };
              return {
                get: (key: string): MiniAppIdbRequestLike<unknown> =>
                  schedule((): unknown => targetStore.get(key)),
                put: (value: unknown, key: string = ""): MiniAppIdbRequestLike<unknown> =>
                  schedule((): unknown => {
                    targetStore.set(key, value);
                    return key;
                  }),
                delete: (key: string): MiniAppIdbRequestLike<unknown> =>
                  schedule((): unknown => {
                    targetStore.delete(key);
                    return undefined;
                  }),
              };
            },
          };
          return tx;
        },
        close: (): void => {},
      };

      const openReq: {
        result?: MiniAppIdbDatabaseLike;
        error?: unknown;
        onsuccess: ((event?: unknown) => void) | null;
        onerror: ((event?: unknown) => void) | null;
        onupgradeneeded?: ((event?: unknown) => void) | null;
        onblocked?: ((event?: unknown) => void) | null;
      } = {
        result: db,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      queueMicrotask((): void => {
        if (needsUpgrade) {
          openReq.onupgradeneeded?.();
        }
        openReq.onsuccess?.();
      });
      return openReq;
    },
  };
}

/**
 * 获取（并按十六进制字符串缓存复用）单测模拟服务端使用的 `AES-GCM` `CryptoKey`。
 *
 * @param hexKey 64 位十六进制密钥
 * @returns `CryptoKey` Promise
 */
function getCachedTestCryptoKey(hexKey: string): Promise<CryptoKey> {
  const normalized: string = hexKey.trim().toLowerCase();
  let cached: Promise<CryptoKey> | undefined = testCryptoKeyCache.get(normalized);
  if (cached === undefined) {
    cached = importMiniAppAesGcmKey(normalized);
    testCryptoKeyCache.set(normalized, cached);
  }
  return cached;
}

/**
 * 在模拟服务端密钥表与前端会话闭包/存储中同步写入带有效 256-bit 会话密钥的测试登录会话。
 *
 * @param token 64 位十六进制会话令牌
 * @param expiresAt 到期毫秒时间戳
 * @param sessionKey 64 位十六进制会话密钥（默认 `TEST_SESSION_KEY`）
 */
export function seedTestMiniAppSession(
  token: string,
  expiresAt?: number,
  sessionKey: string = TEST_SESSION_KEY
): void {
  const normalizedKey: string = sessionKey.trim().toLowerCase();
  mockServerSessionKeys.set(token.trim(), normalizedKey);
  setMiniAppSessionToken(token, expiresAt, normalizedKey);
}

/**
 * 判断测试请求路径是否属于请求体不走会话密钥加密的路由。
 *
 * @param pathname URL 路径名
 * @returns 免会话密钥加密请求体时返回 `true`
 */
function isUnencryptedRequestBodyPath(pathname: string): boolean {
  return (
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/precheck" ||
    pathname === "/api/auth/logout"
  );
}

/**
 * 判断测试请求路径是否属于响应体不走会话密钥封装的路由。
 *
 * @param pathname URL 路径名
 * @returns 免会话密钥加密响应体时返回 `true`
 */
function isUnencryptedResponsePath(pathname: string): boolean {
  return (
    isUnencryptedRequestBodyPath(pathname) ||
    pathname === "/api/gallery/file" ||
    pathname === "/api/gallery/download"
  );
}

/**
 * 解密前端发出的 `MiniAppEncryptedEnvelope` 请求体；若非空字符串请求体未按信封加密则直接抛错断言失败。
 *
 * @param rawBody `RequestInit["body"]` 原始值
 * @param sessionKeyHex 用于解密的 64 位十六进制会话密钥
 * @param additionalData 可选 AEAD 附加认证数据（如 `${METHOD} ${canonicalPath}:req`）
 * @returns 解密后的明文 JSON 字符串；空请求体返回 `null`
 */
export async function decryptTestRequestBody(
  rawBody: RequestInit["body"],
  sessionKeyHex: string = TEST_SESSION_KEY,
  additionalData?: Uint8Array<ArrayBuffer>
): Promise<string | null> {
  if (rawBody === undefined || rawBody === null) return null;
  if (typeof rawBody !== "string") return null;
  if (rawBody.length === 0) return "";
  const envelope: Readonly<MiniAppEncryptedEnvelope> | null =
    parseMiniAppEncryptedEnvelope(JSON.parse(rawBody));
  if (envelope === null) {
    throw new Error(`Expected MiniAppEncryptedEnvelope request body, got: ${rawBody}`);
  }
  const key: CryptoKey = await getCachedTestCryptoKey(sessionKeyHex);
  const decrypted: string | null = await decryptMiniAppText({
    cryptoKey: key,
    encrypted: envelope,
    additionalData,
  });
  if (decrypted === null) {
    throw new Error("Failed to decrypt MiniAppEncryptedEnvelope request body.");
  }
  return decrypted;
}

/** `encryptTestJsonResponse` 构造加密测试响应的可选配置。 */
export interface EncryptTestJsonResponseOptions {
  readonly sessionKeyHex?: string;
  readonly additionalData?: Uint8Array<ArrayBuffer>;
}

/**
 * 将明文 JSON 对象加密封装为测试服务端返回的 `MiniAppEncryptedEnvelope` `Response`。
 *
 * @param payload 明文 JSON 载荷
 * @param init 可选的 `ResponseInit`
 * @param options 可选会话密钥与 AEAD 附加认证数据配置
 * @returns 加密后的 JSON `Response`
 */
export async function encryptTestJsonResponse(
  payload: unknown,
  init?: ResponseInit,
  options?: Readonly<EncryptTestJsonResponseOptions>
): Promise<Response> {
  const key: CryptoKey = await getCachedTestCryptoKey(
    options?.sessionKeyHex ?? TEST_SESSION_KEY
  );
  const envelope: Readonly<MiniAppEncryptedEnvelope> = await encryptMiniAppEnvelope(
    key,
    JSON.stringify(payload),
    options?.additionalData
  );
  return Response.json(envelope, init);
}

/** `wrapEncryptedTestFetch` 包装的下游明文路由回调签名。 */
export type PlaintextTestFetchHandler = (
  url: URL,
  decryptedInit: RequestInit | undefined,
  rawInit: RequestInit | undefined
) => Response | Promise<Response>;

/**
 * 将测试文件的明文路由模拟函数包装为真实执行 TLS 模式 Ed25519 签名临时 X25519 登录握手、
 * 方向 AAD 绑定的查询串与请求体解密、响应加密及续期密钥头封装的 `fetch` 替身（同时向前端注入测试用源站静态 Ed25519 公钥）。
 *
 * @param handler 接收解密后 `URL` 与 `RequestInit` 并返回明文 `Response` 的测试路由处理器
 * @param nextRotatedKey 触发令牌轮换时签发的新会话密钥（默认 `TEST_ROTATED_SESSION_KEY`）
 * @returns 符合 `typeof fetch` 签名的加密传输模拟函数
 */
export function wrapEncryptedTestFetch(
  handler: PlaintextTestFetchHandler,
  nextRotatedKey: string = TEST_ROTATED_SESSION_KEY
): typeof fetch {
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
  const signingKey: CryptoKey = TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey;
  const issuedHandshakes: Map<string, IssuedMockHandshake> = new Map<
    string,
    IssuedMockHandshake
  >();

  return (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url: URL = new URL(String(input), "http://mini.test/");
    const method: string = (init?.method ?? "GET").toUpperCase();
    const canonicalPath: string = resolveCanonicalMiniAppApiPath(url.pathname);
    const reqHeaders: Headers = new Headers(init?.headers);
    const reqSessionToken: string =
      reqHeaders.get(MINI_APP_SESSION_HEADER)?.trim() ?? "";
    const activeKeyHex: string =
      mockServerSessionKeys.get(reqSessionToken) ?? TEST_SESSION_KEY;

    // 拦截并核验 `POST /api/auth/login` 的临时 X25519 ECDH 加密登录请求与 `s2cKey` 响应封装。
    if (canonicalPath === "/api/auth/login" && method === "POST") {
      const rawBodyText: string =
        typeof init?.body === "string" ? init.body : "";
      const bodyRecord: Record<string, unknown> = asPayloadRecord(
        rawBodyText.length > 0 ? JSON.parse(rawBodyText) : null
      );
      const handshakeId: string =
        typeof bodyRecord.handshakeId === "string"
          ? bodyRecord.handshakeId.trim().toLowerCase()
          : "";
      const clientPublicKey: string =
        typeof bodyRecord.clientPublicKey === "string"
          ? bodyRecord.clientPublicKey.trim()
          : "";
      const encryptedPayload: Readonly<MiniAppEncryptedPayload> | null =
        parseMiniAppEncryptedPayload(bodyRecord.encryptedPayload);
      const handshakeRecord: IssuedMockHandshake | undefined =
        issuedHandshakes.get(handshakeId);
      if (
        !MINI_APP_HANDSHAKE_ID_HEX_PATTERN.test(handshakeId) ||
        handshakeRecord === undefined ||
        handshakeRecord.expiresAt <= Date.now() ||
        encryptedPayload === null
      ) {
        throw new Error(
          `Expected valid unconsumed login handshake on POST /api/auth/login, got: ${handshakeId}`
        );
      }
      issuedHandshakes.delete(handshakeId);
      const derivedKeys: Readonly<DerivedMiniAppHandshakeKeys> | null =
        await deriveMiniAppHandshakeKeys({
          serverPrivateKey: handshakeRecord.serverPrivateKey,
          handshakeId,
          serverPublicKeyBase64: handshakeRecord.serverPublicKey,
          clientPublicKeyBase64: clientPublicKey,
        });
      if (derivedKeys === null) {
        throw new Error("Failed ECDH key derivation in POST /api/auth/login test mock.");
      }
      const decryptedReqText: string | null = await decryptMiniAppText({
        cryptoKey: derivedKeys.c2sKey,
        encrypted: encryptedPayload,
        additionalData: LOGIN_REQUEST_AAD_BYTES,
      });
      if (decryptedReqText === null) {
        throw new Error("Failed to decrypt encryptedPayload on POST /api/auth/login.");
      }
      const innerRecord: Record<string, unknown> = asPayloadRecord(
        JSON.parse(decryptedReqText)
      );
      if (
        typeof innerRecord.handshakeId !== "string" ||
        innerRecord.handshakeId.trim().toLowerCase() !== handshakeId
      ) {
        throw new Error(
          `Inner decrypted handshakeId mismatch on POST /api/auth/login: ${String(innerRecord.handshakeId)} !== ${handshakeId}`
        );
      }
      const decryptedInit: RequestInit = {
        ...init,
        body: decryptedReqText,
      };
      const rawResponse: Response = await handler(url, decryptedInit, init);
      const contentType: string = (
        rawResponse.headers.get("content-type") ?? ""
      ).toLowerCase();
      if (!contentType.includes("application/json")) {
        return rawResponse;
      }
      const plainText: string = await rawResponse.text();
      if (plainText.length === 0) {
        return rawResponse;
      }
      const parsedLoginObj: unknown = JSON.parse(plainText);
      const loginRec: Record<string, unknown> = asPayloadRecord(parsedLoginObj);
      if (
        rawResponse.ok &&
        typeof loginRec.sessionToken === "string" &&
        typeof loginRec.sessionKey === "string"
      ) {
        mockServerSessionKeys.set(
          loginRec.sessionToken.trim(),
          loginRec.sessionKey.trim().toLowerCase()
        );
      }
      const parsedPlain: Readonly<MiniAppEncryptedEnvelope> | null =
        parseMiniAppEncryptedEnvelope(parsedLoginObj);
      if (parsedPlain !== null) {
        return Response.json(parsedPlain, {
          status: rawResponse.status,
          statusText: rawResponse.statusText,
          headers: rawResponse.headers,
        });
      }
      const outHeaders: Headers = new Headers(rawResponse.headers);
      outHeaders.delete("content-length");
      const envelope: Readonly<MiniAppEncryptedEnvelope> =
        await encryptMiniAppEnvelope(
          derivedKeys.s2cKey,
          plainText,
          LOGIN_RESPONSE_AAD_BYTES
        );
      return Response.json(envelope, {
        status: rawResponse.status,
        statusText: rawResponse.statusText,
        headers: outHeaders,
      });
    }

    let decryptedUrl: URL = url;
    const isTicketDownloadRequest: boolean =
      canonicalPath === "/api/gallery/download" &&
      (method === "GET" || method === "HEAD") &&
      url.searchParams.has(MINI_APP_DOWNLOAD_TICKET_PARAM);
    if (isTicketDownloadRequest) {
      const ticketKeys: string[] = Array.from(url.searchParams.keys());
      if (
        ticketKeys.length !== 1 ||
        ticketKeys[0] !== MINI_APP_DOWNLOAD_TICKET_PARAM
      ) {
        throw new Error(
          `Expected strict ?${MINI_APP_DOWNLOAD_TICKET_PARAM}=... query on ticket download, got: ${url.search}`
        );
      }
    } else if (
      !isUnencryptedRequestBodyPath(canonicalPath) &&
      (url.search.length > 0 ||
        canonicalPath === "/api/gallery/file" ||
        canonicalPath === "/api/gallery/download")
    ) {
      const queryKeys: string[] = Array.from(url.searchParams.keys());
      const encryptedValues: string[] = url.searchParams.getAll(
        MINI_APP_ENCRYPTED_QUERY_PARAM
      );
      if (
        queryKeys.length !== 1 ||
        queryKeys[0] !== MINI_APP_ENCRYPTED_QUERY_PARAM ||
        encryptedValues.length !== 1
      ) {
        throw new Error(
          `Expected encrypted query (?${MINI_APP_ENCRYPTED_QUERY_PARAM}=...) on ${method} ${canonicalPath}, got: ${url.search}`
        );
      }
      const keyAtSend: CryptoKey = await getCachedTestCryptoKey(activeKeyHex);
      const sealedQuery: string = encryptedValues[0] ?? "";
      const plainQuery: string | null = await unsealMiniAppQuery(
        keyAtSend,
        sealedQuery,
        `${method} ${canonicalPath}`
      );
      if (plainQuery === null || plainQuery.length === 0) {
        throw new Error(
          `Expected valid encrypted query (?${MINI_APP_ENCRYPTED_QUERY_PARAM}=...) on ${method} ${canonicalPath}`
        );
      }
      decryptedUrl = new URL(url.toString());
      decryptedUrl.search = `?${plainQuery}`;
    }

    let decryptedInit: RequestInit | undefined = init;
    if (canonicalPath === "/api/gallery/upload" && method === "POST") {
      if (!(init?.body instanceof Uint8Array)) {
        throw new Error(
          `Expected binary AES-256-GCM Uint8Array request body on POST /api/gallery/upload, got: ${typeof init?.body}`
        );
      }
      const keyAtSend: CryptoKey = await getCachedTestCryptoKey(activeKeyHex);
      const plainBytes: Uint8Array<ArrayBuffer> | null =
        await decryptMiniAppBinary({
          cryptoKey: keyAtSend,
          encryptedBytes: init.body,
          additionalData: buildMiniAppEnvelopeAad(method, canonicalPath, "req"),
        });
      if (plainBytes === null) {
        throw new Error(
          "Failed to decrypt binary AES-256-GCM request body on POST /api/gallery/upload."
        );
      }
      decryptedInit = {
        ...init,
        body: plainBytes,
      };
    } else if (
      !isUnencryptedRequestBodyPath(canonicalPath) &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      if (typeof init?.body !== "string" || init.body.length === 0) {
        throw new Error(
          `Expected non-empty encrypted JSON envelope on ${method} ${canonicalPath}`
        );
      }
      const plainBody: string | null = await decryptTestRequestBody(
        init.body,
        activeKeyHex,
        buildMiniAppEnvelopeAad(method, canonicalPath, "req")
      );
      decryptedInit = {
        ...init,
        body: plainBody ?? "",
      };
    }

    const rawResponse: Response = await handler(decryptedUrl, decryptedInit, init);

    if (canonicalPath === "/api/auth/precheck" && method === "GET" && rawResponse.ok) {
      const plainText: string = await rawResponse.text();
      if (plainText.length === 0) {
        return rawResponse;
      }
      let parsedPrecheck: unknown;
      try {
        parsedPrecheck = JSON.parse(plainText);
      } catch (_error: unknown) {
        return new Response(plainText, {
          status: rawResponse.status,
          statusText: rawResponse.statusText,
          headers: rawResponse.headers,
        });
      }
      const rec: Record<string, unknown> = asPayloadRecord(parsedPrecheck);
      const serverSessionActive: boolean =
        rec.sessionValid === true &&
        typeof rec.sessionExpiresAt === "number" &&
        rec.sessionExpiresAt > Date.now() &&
        reqSessionToken.length > 0;
      if (!serverSessionActive && rec.ok === true && !Object.hasOwn(rec, "handshake")) {
        const x25519Pair: Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }> =
          await generateMiniAppX25519KeyPair();
        const handshakeId: string = generateMiniAppRandomHex(16);
        const expiresAt: number = Date.now() + TEST_HANDSHAKE_TTL_MS;
        const signature: string = await signMiniAppHandshakeOffer(signingKey, {
          handshakeId,
          serverPublicKey: x25519Pair.publicKeyBase64,
          expiresAt,
        });
        issuedHandshakes.set(handshakeId, {
          serverPrivateKey: x25519Pair.privateKey,
          serverPublicKey: x25519Pair.publicKeyBase64,
          expiresAt,
        });
        const offer: Readonly<MiniAppAuthHandshakeOffer> = {
          handshakeId,
          serverPublicKey: x25519Pair.publicKeyBase64,
          expiresAt,
          signature,
        };
        const nextHeaders: Headers = new Headers(rawResponse.headers);
        nextHeaders.delete("content-length");
        return Response.json(
          { ...rec, handshake: offer },
          {
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: nextHeaders,
          }
        );
      }
      return new Response(plainText, {
        status: rawResponse.status,
        statusText: rawResponse.statusText,
        headers: rawResponse.headers,
      });
    }

    const shouldEncryptResponse: boolean =
      method !== "HEAD" && !isUnencryptedResponsePath(canonicalPath);

    const outHeaders: Headers = new Headers(rawResponse.headers);
    const refreshedToken: string =
      outHeaders.get(MINI_APP_SESSION_HEADER)?.trim() ?? "";
    if (
      refreshedToken.length > 0 &&
      refreshedToken !== reqSessionToken &&
      !outHeaders.has(MINI_APP_SESSION_KEY_HEADER)
    ) {
      const keyAtSend: CryptoKey = await getCachedTestCryptoKey(activeKeyHex);
      const normalizedRotated: string = nextRotatedKey.trim().toLowerCase();
      mockServerSessionKeys.set(refreshedToken, normalizedRotated);
      const sealed: string = await sealRotatedMiniAppSessionKey(
        keyAtSend,
        normalizedRotated,
        refreshedToken
      );
      outHeaders.set(MINI_APP_SESSION_KEY_HEADER, sealed);
    }

    const contentType: string = (
      outHeaders.get("content-type") ?? ""
    ).toLowerCase();
    if (
      shouldEncryptResponse &&
      rawResponse.ok &&
      contentType.includes("application/json")
    ) {
      const plainText: string = await rawResponse.text();
      if (plainText.length > 0) {
        const parsedPlain: unknown = JSON.parse(plainText);
        if (parseMiniAppEncryptedEnvelope(parsedPlain) === null) {
          const keyAtSend: CryptoKey = await getCachedTestCryptoKey(activeKeyHex);
          const envelope: Readonly<MiniAppEncryptedEnvelope> =
            await encryptMiniAppEnvelope(
              keyAtSend,
              plainText,
              buildMiniAppEnvelopeAad(method, canonicalPath, "res")
            );
          outHeaders.delete("content-length");
          return Response.json(envelope, {
            status: rawResponse.status,
            statusText: rawResponse.statusText,
            headers: outHeaders,
          });
        }
      }
    }

    if (
      outHeaders.has(MINI_APP_SESSION_KEY_HEADER) !==
      rawResponse.headers.has(MINI_APP_SESSION_KEY_HEADER)
    ) {
      const buf: ArrayBuffer = await rawResponse.arrayBuffer();
      return new Response(buf, {
        status: rawResponse.status,
        statusText: rawResponse.statusText,
        headers: outHeaders,
      });
    }
    return rawResponse;
  }) as typeof fetch;
}
