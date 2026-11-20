/**
 * Mini App 服务端路由一致性测试：
 * - 从 `createMiniAppBunRoutes()` 的键自动展开全部路由与方法，核对根路径部署、`/sub` 子路径前缀（原生前缀键）与剥离前缀转发三种请求的状态码与内容类型完全一致；
 * - 核对跨站拦截、子路径 `308` 补齐斜杠、未命中路由 `404` 以及方法不匹配时的「先鉴权后 404」。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { MiniAppAuthSession } from "../../packages/types/miniApp/auth";
import type {
  MiniAppEncryptedEnvelope,
  MiniAppServiceRestartResult,
} from "../../packages/types/miniApp/configs";
import {
  buildSuperAdminHeaders,
  ensureReusableTestSession,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppActiveUrlPartsHolder,
  miniAppAuthSessions,
  miniAppServiceRestartRunnerHolder,
} = await import(
  "../../packages/cache/main/miniApp"
);
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const { MINI_APP_ENCRYPTED_QUERY_PARAM } = await import(
  "../../packages/consts/miniAppCrypto"
);
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const {
  createMiniAppBunRoutes,
  issueMiniAppAuthSession,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { attachRefreshedSessionHeaders } = await import(
  "../../packages/mini-app-api-server/auth/session"
);
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const { normalizeRoutePathname } = await import(
  "../../packages/mini-app-api-server/libs/routePath"
);
const { encryptMiniAppBinary, sealMiniAppQuery } = await import(
  "../../packages/mini-app-frontend/libs/crypto"
);
const { jsonResponse } = await import(
  "../../packages/mini-app-api-server/libs/response"
);

/** 自动展开的单条路由方法测试样例。 */
interface ExpandedRouteCase {
  readonly routePattern: string;
  readonly method: string;
  readonly samplePath: string;
  readonly rawQuery: string | undefined;
  readonly plainBody: string | undefined;
  readonly encryptRequest: boolean;
  readonly encryptBinaryRequest: boolean;
}

/**
 * 复用或签发当前活跃测试会话并构造超级管理员请求头。
 * @returns 活跃会话与请求头字典。
 */
function superAdminAuth(): {
  readonly session: Readonly<MiniAppAuthSession>;
  readonly headers: Record<string, string>;
} {
  const session: Readonly<MiniAppAuthSession> = ensureReusableTestSession(
    issueMiniAppAuthSession
  );
  return {
    session,
    headers: buildSuperAdminHeaders({
      botToken: BOT_TOKEN,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      sessionToken: session.token,
    }),
  };
}

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与有效会话令牌的测试请求头。
 * @returns 包含 `X-Telegram-Init-Data` 与 `X-Mini-App-Session` 的请求头。
 */
function superAdminHeaders(): Record<string, string> {
  return superAdminAuth().headers;
}

/**
 * 从根路径 `createMiniAppBunRoutes()` 的键集合自动展开全部路由与 HTTP 方法样例。
 * @param routes 根路径下的 `Bun.serve` 原生路由定义对象。
 * @returns 展开后的路由方法测试样例列表。
 */
function expandRouteCases(
  routes: Bun.Serve.Routes<undefined, string>
): readonly Readonly<ExpandedRouteCase>[] {
  const cases: ExpandedRouteCase[] = [];
  for (const [routePattern, entry] of Object.entries(routes)) {
    if (
      entry === undefined ||
      typeof entry !== "object" ||
      entry === null ||
      entry instanceof Response
    ) {
      continue;
    }
    if (routePattern.includes(":")) {
      throw new Error(`Unhandled route parameter placeholder in ${routePattern}`);
    }
    const rawQuery: string | undefined =
      routePattern === "/api/picker/result"
        ? "requestId=1"
        : routePattern === "/api/configs/file"
          ? "scope=dynamic&fileName=mood.json"
          : routePattern === "/api/chats/detail" || routePattern === "/api/chats/targets"
            ? "chatId=-1001"
            : routePattern === "/api/chats/messages"
              ? "chatId=-1001&page=1&pageSize=10"
              : routePattern === "/api/gallery/file" || routePattern === "/api/gallery/download"
                ? "fileName=a.png"
                : undefined;
    for (const method of Object.keys(entry)) {
      const encryptBinaryRequest: boolean =
        routePattern === "/api/gallery/upload" && method === "POST";
      const encryptRequest: boolean =
        routePattern.startsWith("/api/") &&
        routePattern !== "/api/auth/precheck" &&
        routePattern !== "/api/auth/login" &&
        routePattern !== "/api/auth/logout";
      let plainBody: string | undefined;
      if (method !== "GET" && method !== "HEAD") {
        if (routePattern === "/api/auth/login") {
          plainBody = JSON.stringify({
            handshakeId: "0".repeat(32),
            clientPublicKey: "A".repeat(44),
            encryptedPayload: { iv: "aa==", payload: "bb==" },
          });
        } else if (encryptBinaryRequest) {
          plainBody = "";
        } else if (encryptRequest) {
          plainBody = "{}";
        }
      }
      cases.push({
        routePattern,
        method,
        samplePath: routePattern,
        rawQuery,
        plainBody,
        encryptRequest,
        encryptBinaryRequest,
      });
    }
  }
  return cases;
}

/**
 * 为展开后的路由样例构造传输层路径与查询串（加密路由自动将非空查询串封装为 `?e=` 并绑定规范化 `/api/...` AAD）。
 * @param routeCase 单条展开样例。
 * @param session 当前活跃会话。
 * @param basePrefix 可选的子路径前缀（如 `"/sub"`，默认空字符串）。
 * @returns 带可选加密或明文查询串的请求路径。
 */
async function buildWirePath(
  routeCase: Readonly<ExpandedRouteCase>,
  session: Readonly<MiniAppAuthSession>,
  basePrefix: string = ""
): Promise<string> {
  const pathPart: string = `${basePrefix}${routeCase.samplePath}`;
  if (routeCase.rawQuery === undefined) {
    return pathPart;
  }
  if (!routeCase.encryptRequest) {
    return `${pathPart}?${routeCase.rawQuery}`;
  }
  const sealed: string = await sealMiniAppQuery(
    await session.cryptoKey,
    routeCase.rawQuery,
    `${routeCase.method} ${routeCase.samplePath}`
  );
  return `${pathPart}?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealed)}`;
}

/**
 * 为展开后的路由样例构造传输层请求体（加密路由自动封装为 AES-256-GCM 信封或二进制上传帧）。
 * @param routeCase 单条展开样例。
 * @param session 当前活跃会话。
 * @returns 传输层请求体（字符串或加密二进制帧）或 `undefined`。
 */
async function buildWireBody(
  routeCase: Readonly<ExpandedRouteCase>,
  session: Readonly<MiniAppAuthSession>
): Promise<string | Uint8Array<ArrayBuffer> | undefined> {
  if (routeCase.plainBody === undefined) {
    return undefined;
  }
  if (!routeCase.encryptRequest) {
    return routeCase.plainBody;
  }
  if (routeCase.encryptBinaryRequest) {
    return encryptMiniAppBinary(
      await session.cryptoKey,
      new Uint8Array(0),
      buildMiniAppEnvelopeAad(routeCase.method, routeCase.samplePath, "req")
    );
  }
  const envelope: Readonly<MiniAppEncryptedEnvelope> =
    await encryptMiniAppEnvelope(
      await session.cryptoKey,
      routeCase.plainBody,
      buildMiniAppEnvelopeAad(routeCase.method, routeCase.samplePath, "req")
    );
  return JSON.stringify(envelope);
}

/** `readPossiblyEncryptedJson` 读取或解密响应体的入参。 */
interface ReadPossiblyEncryptedJsonOptions {
  readonly response: Response;
  readonly session: Readonly<MiniAppAuthSession>;
  readonly method: string;
  readonly rawPath: string;
}

/**
 * 解析 HTTP JSON 响应体；若外层是加密传输信封则先使用会话密钥及 `:res` AAD 解密再反序列化。
 * @param options 响应、会话、请求方法与原始请求路径（自动剥离 `/sub` 前缀绑定 AAD）。
 * @returns 反序列化后的 JSON 值。
 */
async function readPossiblyEncryptedJson({
  response,
  session,
  method,
  rawPath,
}: Readonly<ReadPossiblyEncryptedJsonOptions>): Promise<unknown> {
  const parsed: unknown = await response.json();
  const envelope: Readonly<MiniAppEncryptedEnvelope> | null =
    parseMiniAppEncryptedEnvelope(parsed);
  if (envelope === null) {
    return parsed;
  }
  const canonicalPath: string = normalizeRoutePathname(rawPath).routePath;
  const plain: string | null = await decryptMiniAppText({
    cryptoKey: await session.cryptoKey,
    encrypted: envelope,
    additionalData: buildMiniAppEnvelopeAad(method, canonicalPath, "res"),
  });
  expect(plain).not.toBeNull();
  return JSON.parse(plain!);
}

async function stubServiceRestartRunner(): Promise<
  Readonly<MiniAppServiceRestartResult>
> {
  return { ok: true };
}

afterEach(async (): Promise<void> => {
  miniAppServiceRestartRunnerHolder.current = null;
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  miniAppAuthSessions.clear();
});

describe("Mini App 原生路由表子路径一致性与兜底分发", () => {
  test("从 createMiniAppBunRoutes() 自动展开全部路由：根路径、/sub 前缀与剥离前缀转发三种请求的状态码与内容类型一致", async () => {
    const rootServer = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(rootServer).not.toBeNull();
    miniAppServiceRestartRunnerHolder.current = stubServiceRestartRunner;
    expect(miniAppActiveUrlPartsHolder.current).toEqual({
      basePath: "/",
      host: "miniapp.example.com",
      origin: "https://miniapp.example.com",
    });
    const rootBase: string = `http://127.0.0.1:${rootServer!.port}`;
    const rootRoutes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
    expect("/_bundle" in rootRoutes).toBeFalse();
    const cases: readonly Readonly<ExpandedRouteCase>[] = expandRouteCases(rootRoutes);
    expect(cases.length).toBeGreaterThanOrEqual(40);

    const rootOutcomes = new Map<
      string,
      { readonly status: number; readonly contentType: string | null }
    >();
    for (const routeCase of cases) {
      const auth = superAdminAuth();
      const wirePath: string = await buildWirePath(routeCase, auth.session);
      const res: Response = await fetch(`${rootBase}${wirePath}`, {
        method: routeCase.method,
        headers: auth.headers,
        body: await buildWireBody(routeCase, auth.session),
      });
      rootOutcomes.set(`${routeCase.method} ${routeCase.samplePath}`, {
        status: res.status,
        contentType: res.headers.get("content-type"),
      });
      await res.arrayBuffer();
    }

    await stopMiniAppServer();
    expect(miniAppActiveUrlPartsHolder.current).toBeNull();

    const subServer = startMiniAppServer({
      url: "https://miniapp.example.com/sub",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(subServer).not.toBeNull();
    miniAppServiceRestartRunnerHolder.current = stubServiceRestartRunner;
    expect(miniAppActiveUrlPartsHolder.current).toEqual({
      basePath: "/sub",
      host: "miniapp.example.com",
      origin: "https://miniapp.example.com",
    });
    const subBase: string = `http://127.0.0.1:${subServer!.port}`;
    const subRoutes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
    expect("/_bundle" in subRoutes).toBeFalse();
    expect("/sub/_bundle" in subRoutes).toBeFalse();
    for (const routeKey of Object.keys(rootRoutes)) {
      expect(routeKey in subRoutes).toBeTrue();
      const expectedPrefixedKey: string = routeKey === "/" ? "/sub/" : `/sub${routeKey}`;
      expect(expectedPrefixedKey in subRoutes).toBeTrue();
    }

    for (const routeCase of cases) {
      const key: string = `${routeCase.method} ${routeCase.samplePath}`;
      const expected = rootOutcomes.get(key)!;

      const prefixedAuth = superAdminAuth();
      const prefixedWirePath: string = await buildWirePath(
        routeCase,
        prefixedAuth.session,
        "/sub"
      );
      const prefixedRes: Response = await fetch(`${subBase}${prefixedWirePath}`, {
        method: routeCase.method,
        headers: prefixedAuth.headers,
        body: await buildWireBody(routeCase, prefixedAuth.session),
      });
      const strippedAuth = superAdminAuth();
      const strippedWirePath: string = await buildWirePath(
        routeCase,
        strippedAuth.session
      );
      const strippedRes: Response = await fetch(`${subBase}${strippedWirePath}`, {
        method: routeCase.method,
        headers: strippedAuth.headers,
        body: await buildWireBody(routeCase, strippedAuth.session),
      });
      expect(`${key} prefixed:${prefixedRes.status}`).toBe(`${key} prefixed:${expected.status}`);
      expect(`${key} stripped:${strippedRes.status}`).toBe(`${key} stripped:${expected.status}`);
      expect(prefixedRes.headers.get("content-type")).toBe(expected.contentType);
      expect(strippedRes.headers.get("content-type")).toBe(expected.contentType);
      await prefixedRes.arrayBuffer();
      await strippedRes.arrayBuffer();
    }
  });

  test("跨站请求在每条鉴权链首位被拒，兜底分发补齐子路径斜杠、未知路径返回 404，且方法不匹配遵循先鉴权后 404", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com/sub",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(server).not.toBeNull();
    miniAppServiceRestartRunnerHolder.current = stubServiceRestartRunner;
    const base: string = `http://127.0.0.1:${server!.port}`;

    const crossSitePaths: readonly string[] = [
      "/sub/api/auth/precheck",
      "/sub/api/status",
      "/sub/api/gallery/file",
      "/sub/api/gallery/download",
    ];
    for (const path of crossSitePaths) {
      const res: Response = await fetch(`${base}${path}`, {
        headers: { ...superAdminHeaders(), "sec-fetch-site": "cross-site" },
      });
      expect(`${path} ${res.status}`).toBe(`${path} 403`);
      expect(((await res.json()) as { readonly code: string }).code).toBe("CROSS_SITE_FORBIDDEN");
    }

    const redirect: Response = await fetch(`${base}/sub?tgWebAppStartParam=1`, {
      redirect: "manual",
    });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/sub/?tgWebAppStartParam=1");

    const notFoundCases: readonly (readonly [string, string])[] = [
      ["/sub/unknown", "Not found"],
      ["/sub/unknown.png", "Resource not found"],
      ["/sub/api/unknown", "API route not found"],
    ];
    for (const [path, error] of notFoundCases) {
      const auth = superAdminAuth();
      const res: Response = await fetch(`${base}${path}`, {
        headers: auth.headers,
      });
      expect(`${path} ${res.status}`).toBe(`${path} 404`);
      expect(await readPossiblyEncryptedJson({ response: res, session: auth.session, method: "GET", rawPath: path })).toEqual({ error });
    }

    // 方法不匹配 → 先鉴权（未认证 401）后 404（已认证 404）。
    const methodMismatchCases: readonly (readonly [string, string, string])[] = [
      ["DELETE", "/sub/api/status", "API route not found"],
      ["POST", "/sub/api/chats", "API route not found"],
      ["POST", "/sub/api/gallery/file", "API route not found"],
      ["DELETE", "/sub/api/gallery/file", "API route not found"],
      ["POST", "/sub/api/gallery/download", "API route not found"],
    ];
    for (const [method, path, expectedError] of methodMismatchCases) {
      const unauthRes: Response = await fetch(`${base}${path}`, { method });
      expect(`${method} ${path} unauth:${unauthRes.status}`).toBe(`${method} ${path} unauth:401`);
      expect(((await unauthRes.json()) as { readonly code: string }).code).toBe("MISSING_INIT_DATA");

      const auth = superAdminAuth();
      const canonicalPath: string = normalizeRoutePathname(path).routePath;
      const body: string | undefined =
        method !== "GET" && method !== "HEAD"
          ? JSON.stringify(
            await encryptMiniAppEnvelope(
              await auth.session.cryptoKey,
              "{}",
              buildMiniAppEnvelopeAad(method, canonicalPath, "req")
            )
          )
          : undefined;
      const authRes: Response = await fetch(`${base}${path}`, {
        method,
        headers: auth.headers,
        body,
      });
      expect(`${method} ${path} auth:${authRes.status}`).toBe(`${method} ${path} auth:404`);
      expect(await readPossiblyEncryptedJson({ response: authRes, session: auth.session, method, rawPath: path })).toEqual({
        error: expectedError,
      });
    }

    const headers: Record<string, string> = superAdminHeaders();
    const adminInitData: string = headers[MINI_APP_INIT_DATA_HEADER]!;
    const rejectedCases: readonly (readonly [string, Record<string, string>, number, string])[] = [
      ["/sub/api/auth/precheck", { ...headers, "sec-fetch-site": "invalid-site" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/sub/api/auth/precheck", { ...headers, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/sub/api/status", { ...headers, accept: "text/html,application/xhtml+xml" }, 403, "DIRECT_NAVIGATION_FORBIDDEN"],
      ["/sub/api/status", { ...headers, origin: "https://evil.example.com" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/sub/api/status", { ...headers, origin: "ftp://evil.example.com" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/sub/api/status", { ...headers, origin: "null" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/sub/api/status", { ...headers, referer: "https://evil.example.com/attack" }, 403, "CROSS_SITE_FORBIDDEN"],
      ["/sub/api/auth/precheck", { authorization: "Bearer some-token" }, 401, "MISSING_INIT_DATA"],
      ["/sub/api/auth/precheck", { [MINI_APP_INIT_DATA_HEADER]: adminInitData, authorization: `tma ${adminInitData}&extra=1` }, 401, "INVALID_SIGNATURE"],
      ["/sub/api/auth/precheck", { [MINI_APP_INIT_DATA_HEADER]: "foo=bar" }, 401, "MALFORMED_INIT_DATA"],
    ];
    for (const [path, reqHeaders, expectedStatus, expectedCode] of rejectedCases) {
      const res: Response = await fetch(`${base}${path}`, { headers: reqHeaders });
      expect(res.status).toBe(expectedStatus);
      expect(((await res.json()) as { readonly code: string }).code).toBe(expectedCode);
    }

    const sameOriginRes: Response = await fetch(`${base}/sub/api/auth/precheck`, {
      headers: {
        ...headers,
        origin: "https://miniapp.example.com",
        referer: "https://miniapp.example.com/sub/",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    expect(sameOriginRes.status).toBe(200);

    const sampleSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(1_000);
    const firstResponse: Response = jsonResponse({ ok: true });
    const secondResponse: Response = jsonResponse({ ok: true });
    attachRefreshedSessionHeaders(firstResponse, sampleSession);
    expect(firstResponse.headers.get(MINI_APP_SESSION_HEADER)).toBe(sampleSession.token);
    expect(secondResponse.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
  });
});
