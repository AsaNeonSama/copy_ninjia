/**
 * Mini App 鉴权与门禁全量基准链路：未授权拒绝页、单页门禁 Cookie 放行与临时 X25519 ECDH 登录握手。
 *
 * 本文件不加载生产模块图（见 scripts/conventions/moduleBoundaries.ts 的全量基准 import
 * 边界）：生产入口由 chain.ts 在子进程里装配后注入，这里只 import 纯常量与类型。
 */

import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_PAGE_GATE_COOKIE_NAME,
} from "../../../packages/consts/miniApp";
import {
  MINI_APP_LOGIN_REQUEST_AAD,
  MINI_APP_LOGIN_RESPONSE_AAD,
} from "../../../packages/consts/miniAppCrypto";
import { buildBenchmarkSignedInitData } from "../miniAppInitData";
import type { evaluateMiniAppPageGateRequest } from "../../../packages/mini-app-api-server/auth/pageGate";
import type {
  DerivedClientMiniAppHandshakeKeys,
  VerifyMiniAppHandshakeOfferResult,
} from "../../../packages/mini-app-frontend/libs/handshakeCrypto";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppAuthPrecheckResponse,
  MiniAppLoginSuccessResponse,
  MiniAppRuntimeSigningKeyPair,
} from "../../../packages/types/miniApp/auth";
import type { MiniAppEncryptedPayload } from "../../../packages/types/miniApp/configs";
import type {
  MiniAppBunRouteHandler,
  MiniAppBunRouteTable,
} from "../../../packages/types/miniApp/server";
import type { ChainDefinition } from "./chainDefinition";
import type { MiniAppChainDependencies } from "./miniAppChainTypes";

/** `POST /api/auth/login` 请求加密复用的 UTF-8 AAD 字节。 */
const BENCHMARK_LOGIN_REQUEST_AAD_BYTES: Uint8Array<ArrayBuffer> =
  new TextEncoder().encode(MINI_APP_LOGIN_REQUEST_AAD);

/** `POST /api/auth/login` 响应解密复用的 UTF-8 AAD 字节。 */
const BENCHMARK_LOGIN_RESPONSE_AAD_BYTES: Uint8Array<ArrayBuffer> =
  new TextEncoder().encode(MINI_APP_LOGIN_RESPONSE_AAD);

/**
 * 构造 Mini App 未授权拒绝页请求链路（`serveMiniAppRejectHtml`）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-reject-page` 链路定义。
 */
export function miniAppRejectPageChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const headers: Readonly<Record<string, string>> = {
    "Sec-Fetch-Site": "same-origin",
  };
  return {
    chain: "mini-app-reject-page",
    operations: dependencies.chainMiniAppRejectPages,
    recordsPerOperation: 1,
    prepare: (): void => {
      dependencies.miniAppRejectHtmlHolder.current = null;
    },
    run: async (sequence: number): Promise<void> => {
      const request: Request = new Request("http://127.0.0.1/", {
        method: "GET",
        headers,
      });
      const response: Response = await dependencies.serveMiniAppRejectHtml(
        request,
        {
          status: 401,
          code: "MISSING_INIT_DATA",
          error: "MISSING_INIT_DATA",
        },
        false
      );
      if (response.status !== 200) {
        throw new Error(
          `Mini App reject-page request ${sequence} returned HTTP ${response.status}.`
        );
      }
      const html: string = await response.text();
      if (
        !html.includes('data-status="401"') ||
        !html.includes('data-code="MISSING_INIT_DATA"')
      ) {
        throw new Error(
          `Mini App reject-page response ${sequence} lacked injected diagnostics.`
        );
      }
    },
    cleanup: (): void => {
      dependencies.miniAppRejectHtmlHolder.current = null;
    },
  };
}

/**
 * 构造 Mini App 单页门禁 Cookie 放行链路（`evaluateMiniAppPageGateRequest`）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-page-gate-allow` 链路定义。
 */
export function miniAppPageGateAllowChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const headersHolder: {
    current: Readonly<Record<string, string>> | null;
  } = { current: null };

  return {
    chain: "mini-app-page-gate-allow",
    operations: dependencies.chainMiniAppPageGates,
    recordsPerOperation: 1,
    prepare: (): void => {
      const secretKey: Uint8Array = dependencies.deriveMiniAppPageGateSecretKey(
        dependencies.botToken
      );
      const token: string = dependencies.issueMiniAppPageGateToken({
        secretKey,
        superAdminUserId: dependencies.superAdminUserId,
        nowMs: Date.now(),
      });
      headersHolder.current = {
        Cookie: `${MINI_APP_PAGE_GATE_COOKIE_NAME}=${token}`,
        "Sec-Fetch-Site": "same-origin",
      };
    },
    run: (sequence: number): void => {
      const headers: Readonly<Record<string, string>> | null =
        headersHolder.current;
      if (headers === null) {
        throw new Error("Mini App page-gate benchmark headers were not prepared.");
      }
      const request: Request = new Request("http://127.0.0.1/", {
        method: "GET",
        headers,
      });
      const decision: ReturnType<typeof evaluateMiniAppPageGateRequest> =
        dependencies.evaluateMiniAppPageGateRequest(request);
      if (!decision.allowed || decision.issueGateCookie) {
        throw new Error(
          `Mini App page-gate allow request ${sequence} was unexpectedly denied.`
        );
      }
    },
    cleanup: (): void => {
      headersHolder.current = null;
    },
  };
}

/**
 * 构造 Mini App TLS 模式临时 ECDH 登录握手完整链路（`GET /api/auth/precheck` 验签临时 X25519 公钥 → `POST /api/auth/login` 加密认证并换取 45 分钟 AES PSK）。
 * @param dependencies Mini App 链路依赖集合。
 * @returns `mini-app-auth-login` 链路定义。
 */
export function miniAppAuthLoginChain(
  dependencies: MiniAppChainDependencies
): ChainDefinition {
  const precheckHandlerHolder: { current: MiniAppBunRouteHandler | null } = {
    current: null,
  };
  const loginHandlerHolder: { current: MiniAppBunRouteHandler | null } = {
    current: null,
  };
  const headersHolder: {
    current: Readonly<Record<string, string>> | null;
  } = { current: null };

  return {
    chain: "mini-app-auth-login",
    operations: dependencies.chainMiniAppAuthLogins,
    recordsPerOperation: 1,
    prepare: async (): Promise<void> => {
      dependencies.miniAppAuthSessions.clear();
      dependencies.miniAppAuthHandshakes.clear();
      dependencies.miniAppPasswordGuardHolder.current = null;
      dependencies.resetMiniAppTotpMemoryCache();
      const runtimeSigningKey: Readonly<MiniAppRuntimeSigningKeyPair> =
        await dependencies.ensureMiniAppRuntimeSigningKeyPair();
      dependencies.setMiniAppServerSigningPublicKeyForTest(
        runtimeSigningKey.publicKeyBase64
      );
      const nowSeconds: number = Math.floor(Date.now() / 1_000);
      const initData: string = buildBenchmarkSignedInitData(
        dependencies.deriveMiniAppInitDataSecretKey(dependencies.botToken),
        dependencies.superAdminUserId,
        nowSeconds
      );
      headersHolder.current = {
        [MINI_APP_INIT_DATA_HEADER]: initData,
        "Content-Type": "application/json",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      const routes: MiniAppBunRouteTable =
        await dependencies.loadAuthBunRoutes();
      const precheckHandler: MiniAppBunRouteHandler | undefined =
        routes["/api/auth/precheck"]?.GET;
      const loginHandler: MiniAppBunRouteHandler | undefined =
        routes["/api/auth/login"]?.POST;
      if (precheckHandler === undefined || loginHandler === undefined) {
        throw new Error(
          "Mini App auth-login benchmark GET /api/auth/precheck or POST /api/auth/login route is missing."
        );
      }
      precheckHandlerHolder.current = precheckHandler;
      loginHandlerHolder.current = loginHandler;
    },
    run: async (sequence: number): Promise<void> => {
      const precheckHandler: MiniAppBunRouteHandler | null =
        precheckHandlerHolder.current;
      const loginHandler: MiniAppBunRouteHandler | null =
        loginHandlerHolder.current;
      const headers: Readonly<Record<string, string>> | null =
        headersHolder.current;
      if (
        precheckHandler === null ||
        loginHandler === null ||
        headers === null
      ) {
        throw new Error("Mini App auth-login benchmark route was not prepared.");
      }
      const precheckRes: Response = await precheckHandler(
        new Request("http://127.0.0.1/api/auth/precheck", {
          method: "GET",
          headers,
        })
      );
      if (precheckRes.status !== 200) {
        throw new Error(
          `Mini App auth-precheck request ${sequence} returned HTTP ${precheckRes.status}.`
        );
      }
      const precheckPayload: Partial<MiniAppAuthPrecheckResponse> =
        (await precheckRes.json()) as Partial<MiniAppAuthPrecheckResponse>;
      const offer: Readonly<MiniAppAuthHandshakeOffer> | undefined =
        precheckPayload.handshake;
      const verified: VerifyMiniAppHandshakeOfferResult | null =
        offer === undefined
          ? null
          : await dependencies.verifyMiniAppHandshakeOfferDetailed(offer);
      if (precheckPayload.ok !== true || offer === undefined || verified?.ok !== true) {
        throw new Error(
          `Mini App auth-precheck response ${sequence} returned an invalid or unverified handshake offer.`
        );
      }

      const clientKeyPair: Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }> =
        await dependencies.generateClientMiniAppX25519KeyPair();
      const derivedKeys: Readonly<DerivedClientMiniAppHandshakeKeys> =
        await dependencies.deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: clientKeyPair.privateKey,
          serverPublicKeyBase64: offer.serverPublicKey,
          clientPublicKeyBase64: clientKeyPair.publicKeyBase64,
          handshakeId: offer.handshakeId,
        });
      const encryptedPayload: Readonly<MiniAppEncryptedPayload> =
        await dependencies.encryptMiniAppPayload(
          derivedKeys.c2sKey,
          JSON.stringify({
            handshakeId: offer.handshakeId,
            password: dependencies.miniAppPassword,
          }),
          BENCHMARK_LOGIN_REQUEST_AAD_BYTES
        );
      const loginRes: Response = await loginHandler(
        new Request("http://127.0.0.1/api/auth/login", {
          method: "POST",
          headers,
          body: JSON.stringify({
            handshakeId: offer.handshakeId,
            clientPublicKey: clientKeyPair.publicKeyBase64,
            encryptedPayload,
          }),
        })
      );
      if (loginRes.status !== 200) {
        throw new Error(
          `Mini App auth-login request ${sequence} returned HTTP ${loginRes.status}.`
        );
      }
      const setCookie: string | null = loginRes.headers.get("set-cookie");
      if (
        setCookie?.includes(`${MINI_APP_PAGE_GATE_COOKIE_NAME}=`) !== true
      ) {
        throw new Error(
          `Mini App auth-login response ${sequence} lacked page-gate Set-Cookie.`
        );
      }
      const envelope: unknown = await loginRes.json();
      if (!dependencies.isMiniAppEncryptedEnvelope(envelope)) {
        throw new Error(
          `Mini App auth-login response ${sequence} lacked an encrypted response envelope.`
        );
      }
      let decryptedText: string;
      try {
        decryptedText = await dependencies.decryptMiniAppPayload(
          derivedKeys.s2cKey,
          envelope,
          BENCHMARK_LOGIN_RESPONSE_AAD_BYTES
        );
      } catch (error: unknown) {
        throw new Error(
          `Mini App auth-login response ${sequence} failed AES-256-GCM decryption.`,
          { cause: error }
        );
      }
      const issued: Partial<MiniAppLoginSuccessResponse> = JSON.parse(
        decryptedText
      ) as Partial<MiniAppLoginSuccessResponse>;
      if (
        issued.ok !== true ||
        typeof issued.sessionToken !== "string" ||
        issued.sessionToken.length === 0 ||
        typeof issued.sessionKey !== "string" ||
        issued.sessionKey.length === 0
      ) {
        throw new Error(
          `Mini App auth-login response ${sequence} returned an incomplete session payload.`
        );
      }
      dependencies.miniAppAuthSessions.delete(issued.sessionToken);
    },
    cleanup: (): void => {
      dependencies.miniAppAuthSessions.clear();
      dependencies.miniAppAuthHandshakes.clear();
      dependencies.miniAppPasswordGuardHolder.current = null;
      dependencies.resetMiniAppTotpMemoryCache();
      precheckHandlerHolder.current = null;
      loginHandlerHolder.current = null;
      dependencies.setMiniAppServerSigningPublicKeyForTest(null);
      headersHolder.current = null;
    },
  };
}
