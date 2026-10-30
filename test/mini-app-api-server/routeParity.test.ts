/**
 * Mini App 服务端路由一致性测试：
 * - 从 `createMiniAppBunRoutes()` 的键自动展开全部路由与方法，核对根路径部署、`/sub` 子路径前缀（原生前缀键）与剥离前缀转发三种请求的状态码与内容类型完全一致；
 * - 核对跨站拦截、子路径 `308` 补齐斜杠、未命中路由 `404` 以及方法不匹配时的「先鉴权后 404」。
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import type { DomainFlushOutcome } from "../../packages/types/diskIO";
import type { BlocklistIdPage, IdentityPolicyRawReadResult, WhitelistIdPage } from "../../packages/types/identityStorage";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { buildSignedTestInitData } from "../helpers/miniAppInitData";

mock.module(
  "../../packages/infra/diskIO",
  () =>
    diskIOStub({
      isDiskIOInitialized: (): boolean => true,
      flushDiskIODomain: async (): Promise<DomainFlushOutcome> => ({ result: "flushed" }),
      onDiskIOReply: diskIOReplyStub({}),
      postDiskIO: (): boolean => true,
      readIdentityPolicies: async (): Promise<IdentityPolicyRawReadResult> => ({
        whitelist: [],
        blocklist: [],
        temporaryAdBypass: [],
      }),
      readWhitelistIdPage: async (afterId: number | null): Promise<WhitelistIdPage> => ({
        ids: [],
        nextCursor: afterId,
        done: true,
      }),
      readBlocklistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> => ({
        ids: [],
        nextCursor: afterId,
        done: true,
      }),
      relayLogMessage: (): boolean => true,
    })
);

const { miniAppAuthSessions } = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const {
  createMiniAppBunRoutes,
  issueMiniAppAuthSession,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");

/** 自动展开的单条路由方法测试样例。 */
interface ExpandedRouteCase {
  readonly routePattern: string;
  readonly method: string;
  readonly samplePath: string;
  readonly body: string | undefined;
}

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与 45 分钟有效密码会话的测试请求头。
 * @returns 包含 `X-Telegram-Init-Data` 与 `X-Mini-App-Session` 的请求头。
 */
function superAdminHeaders(): Record<string, string> {
  const initData: string = buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1000),
    user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
  });
  return {
    [MINI_APP_INIT_DATA_HEADER]: initData,
    [MINI_APP_SESSION_HEADER]: issueMiniAppAuthSession().token,
  };
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
      routePattern === "/_bundle" ||
      entry === undefined ||
      typeof entry !== "object" ||
      entry === null ||
      entry instanceof Response
    ) {
      continue;
    }
    const resolvedBase: string = routePattern
      .replace(":chatId", "-1001")
      .replace(":fileName", "a.png");
    if (resolvedBase.includes(":")) {
      throw new Error(`Unhandled route parameter placeholder in ${routePattern}`);
    }
    const samplePath: string =
      routePattern === "/api/picker/result"
        ? `${resolvedBase}?requestId=1`
        : resolvedBase;
    for (const method of Object.keys(entry)) {
      let body: string | undefined;
      if (method === "POST") {
        if (routePattern === "/api/auth/login") {
          body = JSON.stringify({ password: "test-mini-app-password" });
        } else if (
          routePattern !== "/api/totp/setup" &&
          routePattern !== "/api/totp/delete" &&
          routePattern !== "/api/gallery/upload"
        ) {
          body = "{}";
        }
      }
      cases.push({
        routePattern,
        method,
        samplePath,
        body,
      });
    }
  }
  return cases;
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
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
    const rootBase: string = `http://127.0.0.1:${rootServer!.port}`;
    const rootRoutes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
    const cases: readonly Readonly<ExpandedRouteCase>[] = expandRouteCases(rootRoutes);
    expect(cases.length).toBeGreaterThanOrEqual(35);

    const rootOutcomes = new Map<
      string,
      { readonly status: number; readonly contentType: string | null }
    >();
    for (const routeCase of cases) {
      const res: Response = await fetch(`${rootBase}${routeCase.samplePath}`, {
        method: routeCase.method,
        headers: superAdminHeaders(),
        body: routeCase.body,
      });
      rootOutcomes.set(`${routeCase.method} ${routeCase.samplePath}`, {
        status: res.status,
        contentType: res.headers.get("content-type"),
      });
      await res.arrayBuffer();
    }

    await stopMiniAppServer();

    const subServer = startMiniAppServer({
      url: "https://miniapp.example.com/sub",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(subServer).not.toBeNull();
    const subBase: string = `http://127.0.0.1:${subServer!.port}`;
    const subRoutes: Bun.Serve.Routes<undefined, string> = createMiniAppBunRoutes();
    for (const routeKey of Object.keys(rootRoutes)) {
      expect(routeKey in subRoutes).toBeTrue();
      if (routeKey === "/_bundle") {
        expect("/sub/_bundle" in subRoutes).toBeFalse();
      } else {
        const expectedPrefixedKey: string = routeKey === "/" ? "/sub/" : `/sub${routeKey}`;
        expect(expectedPrefixedKey in subRoutes).toBeTrue();
      }
    }

    for (const routeCase of cases) {
      const key: string = `${routeCase.method} ${routeCase.samplePath}`;
      const expected = rootOutcomes.get(key)!;
      const prefixedPath: string = `/sub${routeCase.samplePath}`;

      const prefixedRes: Response = await fetch(`${subBase}${prefixedPath}`, {
        method: routeCase.method,
        headers: superAdminHeaders(),
        body: routeCase.body,
      });
      const strippedRes: Response = await fetch(`${subBase}${routeCase.samplePath}`, {
        method: routeCase.method,
        headers: superAdminHeaders(),
        body: routeCase.body,
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
    const base: string = `http://127.0.0.1:${server!.port}`;

    const crossSitePaths: readonly string[] = [
      "/sub/api/auth/precheck",
      "/sub/api/status",
      "/sub/api/gallery/file/a.png",
      "/sub/api/gallery/download/a.png",
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
      const res: Response = await fetch(`${base}${path}`, {
        headers: superAdminHeaders(),
      });
      expect(`${path} ${res.status}`).toBe(`${path} 404`);
      expect(await res.json()).toEqual({ error });
    }

    // 方法不匹配 → 先鉴权（未认证 401）后 404（已认证 404）。
    const methodMismatchCases: readonly (readonly [string, string, string])[] = [
      ["DELETE", "/sub/api/status", "API route not found"],
      ["POST", "/sub/api/chats", "API route not found"],
      ["POST", "/sub/api/gallery/file/a.png", "Resource not found"],
      ["POST", "/sub/api/gallery/download/a.png", "API route not found"],
    ];
    for (const [method, path, expectedError] of methodMismatchCases) {
      const unauthRes: Response = await fetch(`${base}${path}`, { method });
      expect(`${method} ${path} unauth:${unauthRes.status}`).toBe(`${method} ${path} unauth:401`);
      expect(((await unauthRes.json()) as { readonly code: string }).code).toBe("MISSING_INIT_DATA");

      const authRes: Response = await fetch(`${base}${path}`, {
        method,
        headers: superAdminHeaders(),
      });
      expect(`${method} ${path} auth:${authRes.status}`).toBe(`${method} ${path} auth:404`);
      expect(await authRes.json()).toEqual({ error: expectedError });
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
  });
});
