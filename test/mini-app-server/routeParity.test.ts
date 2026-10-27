/**
 * Mini App 服务端两条入口：`Bun.serve` 原生路由表（`routes/` 各领域片段）与未命中时的兜底分发
 * （`handleMiniAppHttpRequest`）对每条已登记路由的同一请求给出相同的状态码与内容类型；兜底分发的子路径
 * 重定向、跨站拦截与未命中路由的 404。
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
  handleMiniAppHttpRequest,
  issueMiniAppAuthSession,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-server");

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

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  miniAppAuthSessions.clear();
});

describe("Mini App 原生路由表与兜底分发", () => {
  test("Bun.serve 原生路由表与兜底分发对每条已登记路由给出相同的状态码与内容类型", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(server).not.toBeNull();
    const base: string = `http://127.0.0.1:${server!.port}`;
    const cases: readonly (readonly [string, string, string?])[] = [
      ["GET", "/healthz"], ["HEAD", "/healthz"], ["GET", "/"], ["HEAD", "/"],
      ["GET", "/index.html"], ["HEAD", "/index.html"], ["GET", "/favicon.ico"], ["HEAD", "/favicon.ico"],
      ["GET", "/api/auth/precheck"], ["POST", "/api/auth/login", JSON.stringify({ password: "test-mini-app-password" })],
      ["GET", "/api/totp"], ["POST", "/api/totp/setup"], ["POST", "/api/totp/enable", "{}"],
      ["POST", "/api/totp/delete"], ["DELETE", "/api/totp"],
      ["GET", "/api/status"], ["GET", "/api/mood"],
      ["GET", "/api/chats"], ["GET", "/api/chats/-1001"], ["GET", "/api/chats/-1001/messages"],
      ["POST", "/api/chats/-1001/feature", "{}"],
      ["GET", "/api/identities/whitelist"], ["POST", "/api/identities/whitelist", "{}"],
      ["GET", "/api/identities/blocklist"], ["POST", "/api/identities/blocklist", "{}"],
      ["POST", "/api/identities/permission", "{}"], ["POST", "/api/picker/prepare", "{}"],
      ["GET", "/api/picker/result?requestId=1"],
      ["GET", "/api/gallery"], ["POST", "/api/gallery/upload"], ["POST", "/api/gallery/delete", "{}"],
      ["GET", "/api/gallery/file/a.png"], ["HEAD", "/api/gallery/file/a.png"], ["DELETE", "/api/gallery/file/a.png"],
      ["GET", "/api/gallery/download/a.png"], ["HEAD", "/api/gallery/download/a.png"],
      ["GET", "/api/resources/svg/status.svg"], ["HEAD", "/api/resources/svg/status.svg"],
      ["GET", "/miniAppResoures/status.svg"], ["HEAD", "/miniAppResoures/status.svg"],
    ];
    for (const [method, path, body] of cases) {
      const nativeRes: Response = await fetch(`${base}${path}`, {
        method,
        headers: superAdminHeaders(),
        body,
      });
      const fallbackRes: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000${path}`, { method, headers: superAdminHeaders(), body })
      );
      expect(`${method} ${path} ${nativeRes.status}`).toBe(`${method} ${path} ${fallbackRes.status}`);
      expect(nativeRes.headers.get("content-type")).toBe(fallbackRes.headers.get("content-type"));
      await nativeRes.arrayBuffer();
      await fallbackRes.arrayBuffer();
    }
  });

  test("跨站请求在每条鉴权链首位被拒，兜底分发补齐子路径斜杠并对未命中路由返回 404", async () => {
    expect(startMiniAppServer({
      url: "https://miniapp.example.com/sub",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    })).not.toBeNull();
    const crossSitePaths: readonly string[] = [
      "/sub/api/auth/precheck",
      "/sub/api/status",
      "/sub/api/gallery/file/a.png",
      "/sub/api/gallery/download/a.png",
    ];
    for (const path of crossSitePaths) {
      const res: Response = await handleMiniAppHttpRequest(new Request(`http://127.0.0.1:3000${path}`, {
        headers: { ...superAdminHeaders(), "sec-fetch-site": "cross-site" },
      }));
      expect(`${path} ${res.status}`).toBe(`${path} 403`);
      expect(((await res.json()) as { readonly code: string }).code).toBe("CROSS_SITE_FORBIDDEN");
    }

    const redirect: Response = await handleMiniAppHttpRequest(new Request("http://127.0.0.1:3000/sub?tgWebAppStartParam=1"));
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/sub/?tgWebAppStartParam=1");

    const notFoundCases: readonly (readonly [string, string])[] = [
      ["/sub/unknown", "Not found"],
      ["/sub/unknown.png", "Resource not found"],
      ["/sub/api/unknown", "API route not found"],
    ];
    for (const [path, error] of notFoundCases) {
      const res: Response = await handleMiniAppHttpRequest(new Request(`http://127.0.0.1:3000${path}`, {
        headers: superAdminHeaders(),
      }));
      expect(`${path} ${res.status}`).toBe(`${path} 404`);
      expect(await res.json()).toEqual({ error });
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
      const res: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000${path}`, { headers: reqHeaders })
      );
      expect(res.status).toBe(expectedStatus);
      expect(((await res.json()) as { readonly code: string }).code).toBe(expectedCode);
    }

    const sameOriginRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/sub/api/auth/precheck", {
        headers: {
          ...headers,
          origin: "https://miniapp.example.com",
          referer: "https://miniapp.example.com/sub/",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
        },
      })
    );
    expect(sameOriginRes.status).toBe(200);
  });
});
