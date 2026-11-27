/**
 * Mini App 服务端进程内 HTTP 请求分发与 TLS 模式 ECDH 登录握手测试助手：
 * - `dispatchRawMiniAppTestRequest` 原样复刻 `Bun.serve` 的 `routes` 精确匹配与 `fetch` 兜底顺序；
 * - `dispatchMiniAppTestRequest` 在此基础上为携带活跃会话令牌的已认证加密路由自动执行 AES-256-GCM 查询参数封装（`?e=`）、请求信封加密与响应信封解密核验；
 * - `performMiniAppTestEcdhLogin` 完整复刻 `GET /api/auth/precheck`（Ed25519 验签）→ `POST /api/auth/login`（临时 X25519 ECDH + HKDF-SHA256 双向加解密）换取 45 分钟 AES PSK 的真实端到端流程；
 *   客户端角色一律调用 `packages/mini-app-frontend/` 的实现，服务端角色由被测路由完成。
 */

import { miniAppAuthSessions } from "../../packages/cache/main/miniApp";
import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_PROTECTED_ASSET_EXT_PATTERN,
  MINI_APP_SESSION_PREVIOUS_GRACE_MS,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../../packages/consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_PARAM,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
} from "../../packages/consts/miniAppCrypto";
import {
  createMiniAppBunRoutes,
  handleMiniAppHttpRequest,
} from "../../packages/mini-app-api-server";
import { ensureMiniAppRuntimeSigningKeyPair } from "../../packages/mini-app-api-server/auth/handshake";
import { extractSessionToken } from "../../packages/mini-app-api-server/libs/request";
import { normalizeRoutePathname } from "../../packages/mini-app-api-server/libs/routePath";
import {
  buildMiniAppEnvelopeAad,
  decryptMiniAppPayload,
  encodeUtf8Bytes,
  encryptMiniAppBinary,
  encryptMiniAppEnvelope,
  encryptMiniAppPayload,
  isMiniAppEncryptedEnvelope,
  sealMiniAppQuery,
} from "../../packages/mini-app-frontend/libs/crypto";
import {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} from "../../packages/mini-app-frontend/libs/handshakeCrypto";
import type {
  DerivedClientMiniAppHandshakeKeys,
  VerifyMiniAppHandshakeOfferResult,
} from "../../packages/mini-app-frontend/libs/handshakeCrypto";
import { setMiniAppServerSigningPublicKeyForTest } from "../../packages/mini-app-frontend/libs/signingKey";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppAuthPrecheckResponse,
} from "../../packages/types/miniApp/auth";
import type { MiniAppEncryptedPayload } from "../../packages/types/miniApp/configs";

/**
 * 判断归一化后的路由路径与 HTTP 方法在服务端是否启用会话临时密钥加密。
 * @param routePath 归一化后的内部路由路径。
 * @param method 大写 HTTP 方法。
 * @returns 请求、二进制请求体与响应是否启用会话加密的布尔标记。
 */
function resolveTestRouteEncryptionFlags(
  routePath: string,
  method: string
): {
  readonly encryptRequest: boolean;
  readonly encryptBinaryRequest: boolean;
  readonly encryptResponse: boolean;
} {
  if (
    !routePath.startsWith("/api/") ||
    routePath === "/api/auth/precheck" ||
    routePath === "/api/auth/login" ||
    routePath === "/api/auth/logout"
  ) {
    return {
      encryptRequest: false,
      encryptBinaryRequest: false,
      encryptResponse: false,
    };
  }
  if (
    (routePath === "/api/gallery/download" || routePath === "/api/gallery/file") &&
    (method === "GET" || method === "HEAD")
  ) {
    return {
      encryptRequest: true,
      encryptBinaryRequest: false,
      encryptResponse: false,
    };
  }
  if (
    method !== "DELETE" &&
    !routePath.startsWith("/api/") &&
    MINI_APP_PROTECTED_ASSET_EXT_PATTERN.test(routePath)
  ) {
    return {
      encryptRequest: false,
      encryptBinaryRequest: false,
      encryptResponse: false,
    };
  }
  if (routePath === "/api/gallery/upload" && method === "POST") {
    return {
      encryptRequest: true,
      encryptBinaryRequest: true,
      encryptResponse: true,
    };
  }
  return {
    encryptRequest: true,
    encryptBinaryRequest: false,
    encryptResponse: true,
  };
}

/**
 * 按请求发出时携带的会话令牌查找对应的 256-bit `AES-GCM` `CryptoKey`。
 * @param sessionToken 请求携带的会话令牌。
 * @param nowMs 当前毫秒时间戳。
 * @returns 命中的 `CryptoKey`；未命中或已过期时返回 `null`。
 */
async function findSendTimeSessionCryptoKey(
  sessionToken: string,
  nowMs: number
): Promise<CryptoKey | null> {
  if (!MINI_APP_SHA256_HEX_PATTERN.test(sessionToken)) {
    return null;
  }
  const direct = miniAppAuthSessions.get(sessionToken);
  if (direct !== undefined) {
    return direct.expiresAt > nowMs ? await direct.cryptoKey : null;
  }
  for (const session of miniAppAuthSessions.values()) {
    if (
      session.previousToken === sessionToken &&
      session.previousCryptoKey !== undefined &&
      session.expiresAt > nowMs &&
      nowMs - session.createdAt <= MINI_APP_SESSION_PREVIOUS_GRACE_MS
    ) {
      return await session.previousCryptoKey;
    }
  }
  return null;
}

/**
 * 在进程内按 `Bun.serve` 的 `routes` 精确表查找 → `fetch` 兜底顺序原样分发原始测试 HTTP 请求（不自动封装或解封加密信封）。
 * @param request 传入的原始测试 `Request`。
 * @returns 服务端原始 HTTP `Response`。
 */
export async function dispatchRawMiniAppTestRequest(
  request: Request
): Promise<Response> {
  const url: URL = new URL(request.url);
  const method: string = request.method.toUpperCase();
  const routes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
  const entry: unknown = Object.hasOwn(routes, url.pathname)
    ? (routes as Readonly<Record<string, unknown>>)[url.pathname]
    : undefined;
  if (
    typeof entry === "object" &&
    entry !== null &&
    !(entry instanceof Response)
  ) {
    const methodHandler: unknown = Object.hasOwn(entry, method)
      ? (entry as Readonly<Record<string, unknown>>)[method]
      : undefined;
    if (typeof methodHandler === "function") {
      return await (methodHandler as (req: Request) => Response | Promise<Response>)(
        request
      );
    }
  }
  return handleMiniAppHttpRequest(request);
}

/**
 * 在进程内分发 Mini App 测试请求：当目标路由启用了会话密钥加密且请求携带有效会话令牌时，
 * 自动使用发送时刻匹配的会话 256-bit 密钥将业务查询参数封装为 `?e=`（绑定 `${method} ${routePath}` AAD）、
 * 将请求体（含无正文变更路由的 `"{}"`）加密为绑定 `${method} ${routePath}:req` AAD 的 `MiniAppEncryptedEnvelope`，
 * 并在收到加密信封响应后用同一发送时刻会话密钥与 `:res` AAD 校验解密还原响应体（保留原始状态码与响应头）。
 * @param request 传入的测试 `Request`。
 * @returns 完整的 HTTP `Response`。
 */
export async function dispatchMiniAppTestRequest(
  request: Request
): Promise<Response> {
  const url: URL = new URL(request.url);
  const method: string = request.method.toUpperCase();
  const routePath: string = normalizeRoutePathname(url.pathname).routePath;
  if (
    routePath === "/api/gallery/download" &&
    (method === "GET" || method === "HEAD") &&
    url.searchParams.has(MINI_APP_DOWNLOAD_TICKET_PARAM)
  ) {
    return dispatchRawMiniAppTestRequest(request);
  }
  const flags = resolveTestRouteEncryptionFlags(routePath, method);
  if (!flags.encryptRequest && !flags.encryptResponse) {
    return dispatchRawMiniAppTestRequest(request);
  }

  const sessionToken: string = extractSessionToken(request);
  const cryptoKey: CryptoKey | null = await findSendTimeSessionCryptoKey(
    sessionToken,
    Date.now()
  );
  if (cryptoKey === null) {
    return dispatchRawMiniAppTestRequest(request);
  }

  let wireUrl: string = request.url;
  if (
    flags.encryptRequest &&
    url.search.length > 0 &&
    !(
      url.searchParams.size === 1 &&
      url.searchParams.has(MINI_APP_ENCRYPTED_QUERY_PARAM)
    )
  ) {
    const sealedQuery: string = await sealMiniAppQuery(
      cryptoKey,
      url.search.slice(1),
      `${method} ${routePath}`
    );
    const nextUrl: URL = new URL(url.toString());
    nextUrl.search = `?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedQuery)}`;
    wireUrl = nextUrl.toString();
  }

  let wireRequest: Request =
    wireUrl === request.url
      ? request
      : new Request(wireUrl, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      });
  if (flags.encryptRequest && method !== "GET" && method !== "HEAD") {
    const headers: Headers = new Headers(request.headers);
    headers.delete("content-length");
    if (flags.encryptBinaryRequest) {
      const plainBytes: Uint8Array = await request.bytes();
      const wireBytes: Uint8Array<ArrayBuffer> = await encryptMiniAppBinary(
        cryptoKey,
        plainBytes,
        buildMiniAppEnvelopeAad(method, routePath, "req")
      );
      headers.set("content-type", "application/octet-stream");
      wireRequest = new Request(wireUrl, {
        method: request.method,
        headers,
        body: wireBytes,
        signal: request.signal,
      });
    } else {
      const rawBody: string = await request.text();
      const plainBody: string = rawBody.length > 0 ? rawBody : "{}";
      let alreadyEncrypted: boolean;
      try {
        alreadyEncrypted =
          rawBody.length > 0 && isMiniAppEncryptedEnvelope(JSON.parse(rawBody));
      } catch (_error: unknown) {
        alreadyEncrypted = false;
      }
      const wireBody: string = alreadyEncrypted
        ? rawBody
        : JSON.stringify(
          await encryptMiniAppEnvelope(
            cryptoKey,
            plainBody,
            buildMiniAppEnvelopeAad(method, routePath, "req")
          )
        );
      headers.set("content-type", "application/json");
      wireRequest = new Request(wireUrl, {
        method: request.method,
        headers,
        body: wireBody,
        signal: request.signal,
      });
    }
  }

  const wireResponse: Response = await dispatchRawMiniAppTestRequest(wireRequest);
  if (!flags.encryptResponse || method === "HEAD") {
    return wireResponse;
  }

  const wireText: string = await wireResponse.text();
  let parsedWireJson: unknown;
  try {
    parsedWireJson = JSON.parse(wireText);
  } catch (_error: unknown) {
    return new Response(wireText, {
      status: wireResponse.status,
      headers: wireResponse.headers,
    });
  }

  if (!isMiniAppEncryptedEnvelope(parsedWireJson)) {
    return new Response(wireText, {
      status: wireResponse.status,
      headers: wireResponse.headers,
    });
  }

  let decryptedBody: string;
  try {
    decryptedBody = await decryptMiniAppPayload(
      cryptoKey,
      parsedWireJson,
      buildMiniAppEnvelopeAad(method, routePath, "res")
    );
  } catch (error: unknown) {
    throw new Error(
      "Mini App test request helper failed to decrypt server response envelope with send-time session key.",
      { cause: error }
    );
  }
  return new Response(decryptedBody, {
    status: wireResponse.status,
    headers: wireResponse.headers,
  });
}

/** `performMiniAppTestEcdhLogin` 执行 TLS 模式临时 ECDH 登录握手的入参。 */
export interface PerformMiniAppTestEcdhLoginOptions {
  /** 已签名的超级管理员 `initData`。 */
  readonly initData: string;
  /** 内层明文登录凭据字段（如 `{ password }` 或 `{ totpCode }`）。 */
  readonly credentialPayload: Readonly<Record<string, string>>;
  /** 可选源站 Ed25519 公钥 Base64（默认读取当前运行时内存生成的 Ed25519 公钥）。 */
  readonly signingPublicKeyBase64?: string;
  /** 可选外部已获取的握手凭据（省略时先请求 `GET /api/auth/precheck` 并执行 Ed25519 验签）。 */
  readonly handshakeOverride?: Readonly<MiniAppAuthHandshakeOffer>;
  /** 可选基础 URL（默认 `"http://127.0.0.1:3000"`）。 */
  readonly baseUrl?: string;
  /** 可选请求分发器（默认 `dispatchRawMiniAppTestRequest`，真实 HTTP 测试可传入 `fetch`）。 */
  readonly send?: (request: Request) => Promise<Response>;
}

/** `performMiniAppTestEcdhLogin` 跑完预检验签与 ECDH 加密登录后的结构化返回结果。 */
export interface PerformedMiniAppTestEcdhLogin {
  /** `GET /api/auth/precheck` 原始响应（传入 `handshakeOverride` 时为 `null`）。 */
  readonly precheckResponse: Response | null;
  /** 本次登录使用的服务端临时 X25519 握手凭据。 */
  readonly handshake: Readonly<MiniAppAuthHandshakeOffer>;
  /** 客户端生成的 32 字节临时 X25519 公钥 Base64。 */
  readonly clientPublicKeyBase64: string;
  /** `POST /api/auth/login` 原始响应。 */
  readonly loginResponse: Response;
  /** `POST /api/auth/login` HTTP 状态码。 */
  readonly status: number;
  /** 解封响应信封后的内层 JSON 记录（或在握手层直接拒绝时的明文错误记录）。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 完整执行 TLS 模式 Mini App 测试 ECDH 登录流程：
 * 1. 如未传 `handshakeOverride`，请求 `GET /api/auth/precheck` 并用源站 Ed25519 公钥验签 `handshake`；
 * 2. 生成客户端临时 X25519 密钥对并派生 `c2sKey` / `s2cKey`，加密提交 `{ handshakeId, ...credentialPayload }` 到 `POST /api/auth/login`；
 * 3. 对返回的 `MiniAppEncryptedEnvelope` 使用 `s2cKey` + `MINI_APP_LOGIN_RESPONSE_AAD` 解封并解析内层 JSON。
 * @param options 登录凭据、`initData` 与可选握手/分发器配置。
 * @returns 预检响应、握手上下文、登录原始响应与解封后的响应 JSON。
 */
export async function performMiniAppTestEcdhLogin({
  initData,
  credentialPayload,
  signingPublicKeyBase64,
  handshakeOverride,
  baseUrl = "http://127.0.0.1:3000",
  send = dispatchRawMiniAppTestRequest,
}: Readonly<PerformMiniAppTestEcdhLoginOptions>): Promise<
  Readonly<PerformedMiniAppTestEcdhLogin>
> {
  let precheckResponse: Response | null = null;
  let handshake: Readonly<MiniAppAuthHandshakeOffer>;
  if (handshakeOverride !== undefined) {
    handshake = handshakeOverride;
  } else {
    precheckResponse = await send(
      new Request(`${baseUrl}/api/auth/precheck`, {
        method: "GET",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: initData,
        },
      })
    );
    if (!precheckResponse.ok) {
      throw new Error(
        `Mini App test precheck failed with HTTP ${precheckResponse.status}.`
      );
    }
    const precheckBody: MiniAppAuthPrecheckResponse =
      (await precheckResponse.clone().json()) as MiniAppAuthPrecheckResponse;
    if (precheckBody.handshake === undefined) {
      throw new Error("Expected signed handshake offer from /api/auth/precheck.");
    }
    const effectiveSigningPublicKey: string =
      signingPublicKeyBase64 ?? (await ensureMiniAppRuntimeSigningKeyPair()).publicKeyBase64;
    setMiniAppServerSigningPublicKeyForTest(effectiveSigningPublicKey);
    let verified: VerifyMiniAppHandshakeOfferResult;
    try {
      verified = await verifyMiniAppHandshakeOfferDetailed(precheckBody.handshake);
    } finally {
      setMiniAppServerSigningPublicKeyForTest(null);
    }
    if (!verified.ok) {
      throw new Error(
        "Failed to verify Ed25519 signature of /api/auth/precheck handshake offer."
      );
    }
    handshake = precheckBody.handshake;
  }

  const clientKeyPair: Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }> =
    await generateClientMiniAppX25519KeyPair();
  const derived: Readonly<DerivedClientMiniAppHandshakeKeys> =
    await deriveClientMiniAppHandshakeKeys({
      clientPrivateKey: clientKeyPair.privateKey,
      serverPublicKeyBase64: handshake.serverPublicKey,
      clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
      handshakeId: handshake.handshakeId,
    });

  const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
    await encryptMiniAppPayload(
      derived.c2sKey,
      JSON.stringify({
        handshakeId: handshake.handshakeId,
        ...credentialPayload,
      }),
      encodeUtf8Bytes(MINI_APP_LOGIN_REQUEST_AAD)
    );
  const loginResponse: Response = await send(
    new Request(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        [MINI_APP_INIT_DATA_HEADER]: initData,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        handshakeId: handshake.handshakeId,
        clientPublicKey: clientKeyPair.publicKeyBase64,
        encryptedPayload,
      }),
    })
  );

  const rawJson: unknown = await loginResponse.clone().json();
  let payload: Readonly<Record<string, unknown>>;
  if (isMiniAppEncryptedEnvelope(rawJson)) {
    const decryptedText: string = await decryptMiniAppPayload(
      derived.s2cKey,
      rawJson,
      encodeUtf8Bytes(MINI_APP_LOGIN_RESPONSE_AAD)
    );
    payload = JSON.parse(decryptedText) as Readonly<Record<string, unknown>>;
  } else {
    payload = rawJson as Readonly<Record<string, unknown>>;
  }
  return {
    precheckResponse,
    handshake,
    clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
    loginResponse,
    status: loginResponse.status,
    payload,
  };
}
