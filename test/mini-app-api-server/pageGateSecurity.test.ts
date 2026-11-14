/**
 * Mini App 单页门控握手、独立 `reject.html` 精确诊断与前端打包静态资源（`/chunk-*`）双路径隔离回归测试：
 * - 核验根路径与 `${basePath}` 子路径下冷启动未授权请求仅返回独立 `reject.html` 且不触发 `HTMLBundle` 物化，彻底移除 `/_bundle` 路由；
 * - 核验 SuperAdmin 经 `GET /api/auth/precheck` 签发 `HttpOnly` 门禁 Cookie（含反代 `X-Forwarded-Proto: https` 下的 `; Secure`）后访问单页入口与打包产物（含私有协商缓存、`Vary`、`If-None-Match` 304 与 `HEAD`），以及直接携带合法 `X-Telegram-Init-Data` 请求头的双模式闭环；
 * - 核验跨站、直接导航、非超管、错签、过期、畸形凭据与 30 分钟 `PASSWORD_LOCKED` 下的精确 `reject.html` 诊断、门禁 Cookie 主动清除（`Max-Age=0`）及恒定时间无状态门禁令牌边界。
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthSessions,
  miniAppBundledAssetsHolder,
  miniAppBundledAssetsPromiseHolder,
  miniAppPasswordGuardHolder,
  miniAppRejectHtmlHolder,
} = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_BUNDLE_CACHE_CONTROL,
  MINI_APP_BUNDLE_VARY_HEADER_VALUE,
  MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_NO_STORE_CACHE_CONTROL,
  MINI_APP_PAGE_GATE_CLOCK_SKEW_MS,
  MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS,
  MINI_APP_PAGE_GATE_COOKIE_NAME,
  MINI_APP_PASSWORD_LOCKOUT_MS,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_TMA_AUTH_PREFIX,
} = await import("../../packages/consts/miniApp");
const { MINUTE_MS } = await import("../../packages/consts/time");
const {
  deriveMiniAppInitDataSecretKey,
  deriveMiniAppPageGateSecretKey,
  issueMiniAppPageGateToken,
  verifyMiniAppPageGateToken,
} = await import("../../packages/libs/miniAppAuth");
const {
  buildMiniAppPageGateSetCookieHeader,
  hasMiniAppPageGateCookie,
  readMiniAppPageGateCookie,
} = await import("../../packages/mini-app-api-server/auth/pageGate");
const {
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const { dispatchMiniAppTestRequest } = await import("../helpers/miniAppRequest");
import type { MiniAppAccessDiagnostics } from "../../packages/types/miniApp/auth";
import type { BundledMiniAppAssets } from "../../packages/types/miniApp/server";

/** 发送门禁安全测试请求的入参选项。 */
interface SendGateSecurityRequestOptions {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** 非超级管理员测试入侵者 Telegram 用户 ID。 */
const NON_ADMIN_USER_ID: number = SUPER_ADMIN_USER_ID + 777;

/**
 * 生成指定用户与时间戳的合法签名 `initData` 原始查询串。
 * @param userId Telegram 用户 ID。
 * @param authDate 签名秒级时间戳（默认当前时刻）。
 * @returns 带有效 HMAC-SHA256 `hash` 的查询串。
 */
function signInitDataForUser(
  userId: number,
  authDate: number = Math.floor(Date.now() / 1_000)
): string {
  return buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate,
    user: {
      id: userId,
      first_name: userId === SUPER_ADMIN_USER_ID ? "SuperAdmin" : "Intruder",
      username: userId === SUPER_ADMIN_USER_ID ? "super_admin" : "intruder_user",
    },
  });
}

/**
 * 向进程内 Mini App 路由分发器发送单次 HTTP 请求。
 * @param options 请求路径、方法、头与请求体。
 * @returns 服务端 `Response`。
 */
function sendGateSecurityRequest({
  path,
  method = "GET",
  headers = {},
  body,
}: SendGateSecurityRequestOptions): Promise<Response> {
  return dispatchMiniAppTestRequest(
    new Request(`http://127.0.0.1:3000${path}`, { method, headers, body })
  );
}

/**
 * 断言单次未授权 JSON 响应满足预期状态码、诊断错误码与 `no-store` 防缓存头。
 * @param response 待核验的 HTTP 响应。
 * @param expectedStatus 预期 HTTP 状态码。
 * @param expectedCode 预期诊断 `code`。
 */
async function assertBlockedDiagnostics(
  response: Response,
  expectedStatus: number,
  expectedCode: string
): Promise<void> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const requestIdHeader: string | null = response.headers.get("x-request-id");
  expect(requestIdHeader).toMatch(/^[0-9a-f]{16}$/u);
  const diag: MiniAppAccessDiagnostics =
    (await response.json()) as MiniAppAccessDiagnostics;
  expect(diag.status).toBe(expectedStatus);
  expect(diag.code).toBe(expectedCode);
  expect(diag.requestId).toBe(requestIdHeader ?? "");
  expect(diag.host).not.toContain("127.0.0.1");
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppPasswordGuardHolder.current = null;
  setSystemTime();
});

describe("Mini App 单页门控握手与前端打包产物隔离安全测试", () => {
  test("单页门控握手与前端打包产物隔离：根路径与子路径 /sub 下未授权绝不泄露 SPA 或 chunk，SuperAdmin Cookie 与请求头双模式完整闭环", async () => {
    miniAppBundledAssetsHolder.current = null;
    miniAppRejectHtmlHolder.current = null;
    const subServer: ReturnType<typeof Bun.serve> | null = startMiniAppServer({
      url: "https://miniapp.example.com/sub",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(subServer).not.toBeNull();
    const origin: string = `http://127.0.0.1:${subServer!.port}`;
    expect(miniAppRejectHtmlHolder.current).toBeNull();

    // 1. 冷启动下外部浏览器访问 /、/index.html、/sub/、/sub/index.html 仅获 reject.html，模板缓存进内存，且不触发 HTMLBundle 物化。
    for (const coldPath of ["/", "/index.html", "/sub/", "/sub/index.html"]) {
      const coldRes: Response = await fetch(`${origin}${coldPath}`);
      expect(coldRes.status).toBe(200);
      expect(coldRes.headers.get("cache-control")).toBe(MINI_APP_NO_STORE_CACHE_CONTROL);
      expect(coldRes.headers.get("content-security-policy")).toBe(MINI_APP_CSP_HEADER_VALUE);
      const coldHtml: string = await coldRes.text();
      expect(coldHtml).toContain("cf-error-page");
      expect(coldHtml).toContain('data-code="MISSING_INIT_DATA"');
      expect(coldHtml).toContain('data-status="401"');
      expect(coldHtml).not.toContain('id="root"');
      expect(coldHtml).not.toContain("./chunk-");
    }
    expect(miniAppRejectHtmlHolder.current).not.toBeNull();
    expect(miniAppBundledAssetsHolder.current).toBeNull();

    for (const hiddenBundlePath of ["/_bundle", "/sub/_bundle"]) {
      const bundleRes: Response = await fetch(`${origin}${hiddenBundlePath}`);
      expect(bundleRes.status).toBe(404);
    }

    // 2. SuperAdmin 调 /api/auth/precheck 获取 HttpOnly 门禁 Cookie（同时覆盖反代 X-Forwarded-Proto: https 下附加 ; Secure）。
    const superInitData: string = signInitDataForUser(SUPER_ADMIN_USER_ID);
    const precheckHttpRes: Response = await fetch(`${origin}/api/auth/precheck`, {
      headers: { [MINI_APP_INIT_DATA_HEADER]: superInitData },
    });
    expect(precheckHttpRes.status).toBe(200);
    const httpSetCookie: string = precheckHttpRes.headers.get("set-cookie") ?? "";
    expect(httpSetCookie).toContain(`${MINI_APP_PAGE_GATE_COOKIE_NAME}=`);
    expect(httpSetCookie).toContain(`Max-Age=${MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS}`);
    expect(httpSetCookie).toContain("HttpOnly");
    expect(httpSetCookie).toContain("SameSite=Lax");
    expect(httpSetCookie).not.toContain("; Secure");

    const precheckHttpsRes: Response = await fetch(`${origin}/sub/api/auth/precheck`, {
      headers: {
        [MINI_APP_INIT_DATA_HEADER]: superInitData,
        "X-Forwarded-Proto": "https, http",
      },
    });
    expect(precheckHttpsRes.status).toBe(200);
    const httpsSetCookie: string = precheckHttpsRes.headers.get("set-cookie") ?? "";
    expect(httpsSetCookie).toContain("; Secure");
    const gateCookiePair: string = httpSetCookie.split(";")[0]!;

    // 3. 携带门禁 Cookie 并发请求 / 与 /sub/ 共享同一次物化，返回完整前端入口 HTML。
    const settledPages: PromiseSettledResult<Response>[] = await Promise.allSettled([
      fetch(`${origin}/`, { headers: { Cookie: `other_cookie=1; ${gateCookiePair}` } }),
      fetch(`${origin}/sub/`, { headers: { Cookie: gateCookiePair } }),
    ]);
    for (const item of settledPages) {
      expect(item.status).toBe("fulfilled");
      if (item.status !== "fulfilled") continue;
      expect(item.value.status).toBe(200);
      expect(item.value.headers.get("set-cookie")).toBeNull();
      const appHtml: string = await item.value.text();
      expect(appHtml).toContain('id="root"');
      expect(appHtml).toContain("./chunk-");
      expect(appHtml).not.toContain("cf-error-page");
    }

    const headAuthedPage: Response = await fetch(`${origin}/index.html`, {
      method: "HEAD",
      headers: { Cookie: gateCookiePair },
    });
    expect(headAuthedPage.status).toBe(200);
    expect(await headAuthedPage.text()).toBe("");

    // 4. 直接携带合法 SuperAdmin X-Telegram-Init-Data 请求 / 亦放行并下发门禁 Cookie。
    const directHeaderPageRes: Response = await fetch(`${origin}/`, {
      headers: { [MINI_APP_INIT_DATA_HEADER]: superInitData },
    });
    expect(directHeaderPageRes.status).toBe(200);
    expect(directHeaderPageRes.headers.get("set-cookie")).toContain(
      `${MINI_APP_PAGE_GATE_COOKIE_NAME}=`
    );
    const directHtml: string = await directHeaderPageRes.text();
    expect(directHtml).toContain('id="root"');

    // 5. 提取真实打包产物路径，逐一核验根路径与 /sub 子路径下的未授权拒绝、Cookie 放行、InitData 头放行、304 协商与跨站/直接导航拦截。
    const materialized: Readonly<BundledMiniAppAssets> | null =
      miniAppBundledAssetsHolder.current as Readonly<BundledMiniAppAssets> | null;
    const assetPaths: readonly string[] = [...(materialized?.assets.keys() ?? [])];
    expect(assetPaths.some((p: string): boolean => p.endsWith(".js"))).toBeTrue();
    expect(assetPaths.some((p: string): boolean => p.endsWith(".css"))).toBeTrue();

    for (const assetPath of assetPaths) {
      for (const prefix of ["", "/sub"]) {
        const targetUrl: string = `${origin}${prefix}${assetPath}`;

        const unauthChunkRes: Response = await fetch(targetUrl);
        await assertBlockedDiagnostics(unauthChunkRes, 401, "MISSING_INIT_DATA");

        const nonAdminChunkRes: Response = await fetch(targetUrl, {
          headers: { [MINI_APP_INIT_DATA_HEADER]: signInitDataForUser(NON_ADMIN_USER_ID) },
        });
        await assertBlockedDiagnostics(nonAdminChunkRes, 403, "FORBIDDEN_USER");

        const crossSiteChunkRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "Sec-Fetch-Site": "cross-site",
          },
        });
        await assertBlockedDiagnostics(crossSiteChunkRes, 403, "CROSS_SITE_FORBIDDEN");
        expect(crossSiteChunkRes.headers.get("set-cookie")).toContain("Max-Age=0");

        const navigateChunkRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          },
        });
        await assertBlockedDiagnostics(navigateChunkRes, 403, "DIRECT_NAVIGATION_FORBIDDEN");

        const badOriginChunkRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            Origin: "https://evil.example",
          },
        });
        await assertBlockedDiagnostics(badOriginChunkRes, 403, "CROSS_SITE_FORBIDDEN");

        const badRefererChunkRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            Referer: "https://evil.example/page",
          },
        });
        await assertBlockedDiagnostics(badRefererChunkRes, 403, "CROSS_SITE_FORBIDDEN");

        const authedChunkRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": assetPath.endsWith(".js") ? "cors" : "no-cors",
            "Sec-Fetch-Dest": assetPath.endsWith(".js") ? "script" : "style",
          },
        });
        expect(authedChunkRes.status).toBe(200);
        expect(authedChunkRes.headers.get("cache-control")).toBe(
          MINI_APP_BUNDLE_CACHE_CONTROL
        );
        expect(authedChunkRes.headers.get("cdn-cache-control")).toBe("no-store");
        expect(authedChunkRes.headers.get("cloudflare-cdn-cache-control")).toBe(
          "no-store"
        );
        expect(authedChunkRes.headers.get("vary")).toBe(
          MINI_APP_BUNDLE_VARY_HEADER_VALUE
        );
        const etag: string | null = authedChunkRes.headers.get("etag");
        expect(etag).not.toBeNull();
        const chunkBytes: Uint8Array = await authedChunkRes.bytes();
        expect(chunkBytes.byteLength).toBeGreaterThan(0);

        const singleEtagNotModRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "If-None-Match": etag!,
          },
        });
        expect(singleEtagNotModRes.status).toBe(304);

        const singleWeakNotModRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "If-None-Match": `W/${etag!}`,
          },
        });
        expect(singleWeakNotModRes.status).toBe(304);

        const weakNotModRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "If-None-Match": `"mismatch", W/${etag!}`,
          },
        });
        expect(weakNotModRes.status).toBe(304);
        expect(await weakNotModRes.text()).toBe("");

        const starNotModRes: Response = await fetch(targetUrl, {
          headers: {
            Cookie: gateCookiePair,
            "If-None-Match": "*",
          },
        });
        expect(starNotModRes.status).toBe(304);

        const headChunkRes: Response = await fetch(targetUrl, {
          method: "HEAD",
          headers: { [MINI_APP_INIT_DATA_HEADER]: superInitData },
        });
        expect(headChunkRes.status).toBe(200);
        expect(await headChunkRes.text()).toBe("");
      }
    }

    // 已通过门禁校验但并非打包产物的未知 .js 路径回落到 404，不泄露其它文件。
    const missingJsRes: Response = await fetch(`${origin}/sub/chunk-nonexistent-probe.js`, {
      headers: { Cookie: gateCookiePair },
    });
    expect(missingJsRes.status).toBe(404);
  });

  test("单页拒绝页精确诊断、门禁 Cookie 主动清除与无状态门禁令牌边界核验", async () => {
    const baseMs: number = 1_765_000_000_000;
    setSystemTime(new Date(baseMs));
    const server: ReturnType<typeof Bun.serve> | null = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "sec-test-password-123456",
    });
    expect(server).not.toBeNull();
    const nowSec: number = Math.floor(baseMs / 1_000);
    const validSuperInit: string = signInitDataForUser(SUPER_ADMIN_USER_ID, nowSec);
    const flipped: string = validSuperInit.endsWith("0") ? "1" : "0";
    const forgedSigInit: string = `${validSuperInit.slice(0, -1)}${flipped}`;
    const expiredInit: string = signInitDataForUser(
      SUPER_ADMIN_USER_ID,
      nowSec - MINI_APP_AUTH_MAX_AGE_SECONDS - 30
    );
    const nonAdminInit: string = signInitDataForUser(NON_ADMIN_USER_ID, nowSec);

    const gateSecretKey: Uint8Array = deriveMiniAppPageGateSecretKey(BOT_TOKEN);
    expect(gateSecretKey).not.toEqual(deriveMiniAppInitDataSecretKey(BOT_TOKEN));
    const validGateToken: string = issueMiniAppPageGateToken({
      secretKey: gateSecretKey,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      nowMs: baseMs,
    });
    const gateCookieHeader: string = `${MINI_APP_PAGE_GATE_COOKIE_NAME}=${validGateToken}`;

    // 1. 携带旧门禁 Cookie 但请求头出现跨站、非超管、篡改签名、过期 auth_date 或畸形 initData 时，单页入口返回精确 reject.html 并清除 Cookie。
    const rejectPageCases: readonly (readonly [
      Readonly<Record<string, string>>,
      number,
      string
    ])[] = [
      [{ Cookie: gateCookieHeader, "Sec-Fetch-Site": "cross-site" }, 403, "CROSS_SITE_FORBIDDEN"],
      [{ Cookie: gateCookieHeader, Origin: "https://attacker.example" }, 403, "CROSS_SITE_FORBIDDEN"],
      [{ Cookie: gateCookieHeader, [MINI_APP_INIT_DATA_HEADER]: nonAdminInit }, 403, "FORBIDDEN_USER"],
      [{ Cookie: gateCookieHeader, [MINI_APP_INIT_DATA_HEADER]: forgedSigInit }, 401, "INVALID_SIGNATURE"],
      [{ Cookie: gateCookieHeader, [MINI_APP_INIT_DATA_HEADER]: expiredInit }, 401, "EXPIRED_AUTH_DATE"],
      [{ Cookie: gateCookieHeader, [MINI_APP_INIT_DATA_HEADER]: "broken_init_data" }, 401, "MALFORMED_INIT_DATA"],
      [
        {
          Cookie: gateCookieHeader,
          [MINI_APP_INIT_DATA_HEADER]: validSuperInit,
          Authorization: `${MINI_APP_TMA_AUTH_PREFIX}${expiredInit}`,
        },
        401,
        "INVALID_SIGNATURE",
      ],
      [{ Cookie: gateCookieHeader, Authorization: `${MINI_APP_TMA_AUTH_PREFIX}   ` }, 401, "MISSING_INIT_DATA"],
      [{ Cookie: gateCookieHeader, Authorization: "Bearer invalid-scheme" }, 401, "MISSING_INIT_DATA"],
      [{ Cookie: `${MINI_APP_PAGE_GATE_COOKIE_NAME}=forged.token` }, 401, "MISSING_INIT_DATA"],
    ];

    for (const [headers, expectedStatus, expectedCode] of rejectPageCases) {
      const pageRes: Response = await sendGateSecurityRequest({ path: "/", headers });
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get("set-cookie")).toContain("Max-Age=0");
      const html: string = await pageRes.text();
      expect(html).toContain("cf-error-page");
      expect(html).toContain(`data-status="${expectedStatus}"`);
      expect(html).toContain(`data-code="${expectedCode}"`);
      expect(html).not.toContain('id="root"');
      expect(html).not.toContain("./chunk-");
    }

    // precheck 失败时绝不下发有效门禁 Cookie；若请求带了旧门禁 Cookie 则主动下发 Max-Age=0 清除。
    const precheckNonAdminNoCookie: Response = await sendGateSecurityRequest({
      path: "/api/auth/precheck",
      headers: { [MINI_APP_INIT_DATA_HEADER]: nonAdminInit },
    });
    await assertBlockedDiagnostics(precheckNonAdminNoCookie, 403, "FORBIDDEN_USER");
    expect(precheckNonAdminNoCookie.headers.get("set-cookie")).toBeNull();

    const precheckNonAdminWithCookie: Response = await sendGateSecurityRequest({
      path: "/api/auth/precheck",
      headers: {
        [MINI_APP_INIT_DATA_HEADER]: nonAdminInit,
        Cookie: gateCookieHeader,
      },
    });
    await assertBlockedDiagnostics(precheckNonAdminWithCookie, 403, "FORBIDDEN_USER");
    expect(precheckNonAdminWithCookie.headers.get("set-cookie")).toContain("Max-Age=0");

    // 2. 连续 3 次输错密码触发 30 分钟 PASSWORD_LOCKED：第 3 次登录响应清除门禁 Cookie，且此前签发的门禁 Cookie 访问 / 与 /chunk-* 一律被拒并携带剩余分钟数。
    for (let attempt: number = 0; attempt < MINI_APP_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
      const badLoginRes: Response = await sendGateSecurityRequest({
        path: "/api/auth/login",
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: validSuperInit,
          Cookie: gateCookieHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: `wrong-pass-${attempt}` }),
      });
      const isLockStrike: boolean = attempt + 1 === MINI_APP_PASSWORD_MAX_ATTEMPTS;
      await assertBlockedDiagnostics(
        badLoginRes,
        403,
        isLockStrike ? "PASSWORD_LOCKED" : "INVALID_PASSWORD"
      );
      if (isLockStrike) {
        expect(badLoginRes.headers.get("set-cookie")).toContain("Max-Age=0");
      }
    }

    const lockedPageByCookieRes: Response = await sendGateSecurityRequest({
      path: "/",
      headers: { Cookie: gateCookieHeader },
    });
    expect(lockedPageByCookieRes.status).toBe(200);
    expect(lockedPageByCookieRes.headers.get("set-cookie")).toContain("Max-Age=0");
    const lockedHtml: string = await lockedPageByCookieRes.text();
    expect(lockedHtml).toContain('data-code="PASSWORD_LOCKED"');
    expect(lockedHtml).toContain('data-status="403"');
    expect(lockedHtml).toContain(
      `data-remaining-minutes="${MINI_APP_PASSWORD_LOCKOUT_MS / MINUTE_MS}"`
    );
    expect(lockedHtml).not.toContain('id="root"');

    const lockedPageByInitHeaderRes: Response = await sendGateSecurityRequest({
      path: "/index.html",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validSuperInit, Cookie: gateCookieHeader },
    });
    expect(lockedPageByInitHeaderRes.status).toBe(200);
    expect(lockedPageByInitHeaderRes.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await lockedPageByInitHeaderRes.text()).toContain('data-code="PASSWORD_LOCKED"');

    const lockedChunkByCookieRes: Response = await sendGateSecurityRequest({
      path: "/chunk-probe.js",
      headers: { Cookie: gateCookieHeader },
    });
    await assertBlockedDiagnostics(lockedChunkByCookieRes, 403, "PASSWORD_LOCKED");
    expect(lockedChunkByCookieRes.headers.get("set-cookie")).toContain("Max-Age=0");

    const lockedChunkByInitHeaderRes: Response = await sendGateSecurityRequest({
      path: "/chunk-probe.js",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validSuperInit, Cookie: gateCookieHeader },
    });
    await assertBlockedDiagnostics(lockedChunkByInitHeaderRes, 403, "PASSWORD_LOCKED");
    expect(lockedChunkByInitHeaderRes.headers.get("set-cookie")).toContain("Max-Age=0");

    // 3. 零分配 Cookie 扫描器、HTTPS Secure 标记、根层图片 ?token= 分流、物化失败 500 兜底、stopMiniAppServer 模板缓存清理与恒定时间门禁令牌边界核验。
    miniAppPasswordGuardHolder.current = null;
    const forgedChunkCookieRes: Response = await sendGateSecurityRequest({
      path: "/chunk-probe.js",
      headers: { Cookie: `${MINI_APP_PAGE_GATE_COOKIE_NAME}=forged.token` },
    });
    await assertBlockedDiagnostics(forgedChunkCookieRes, 401, "MISSING_INIT_DATA");
    expect(forgedChunkCookieRes.headers.get("set-cookie")).toContain("Max-Age=0");

    const rootImgTokenFallbackRes: Response = await sendGateSecurityRequest({
      path: "/probe-root.png?token=bad_token",
    });
    await assertBlockedDiagnostics(rootImgTokenFallbackRes, 401, "INVALID_SIGNATURE");

    const rootImgWithGateCookieRes: Response = await sendGateSecurityRequest({
      path: "/probe-root.png?token=bad_token",
      headers: { Cookie: gateCookieHeader },
    });
    expect(rootImgWithGateCookieRes.status).toBe(401);

    miniAppBundledAssetsHolder.current = null;
    miniAppBundledAssetsPromiseHolder.current = Promise.resolve(null);
    const failedPageGetRes: Response = await sendGateSecurityRequest({
      path: "/",
      headers: { [MINI_APP_INIT_DATA_HEADER]: validSuperInit },
    });
    expect(failedPageGetRes.status).toBe(500);
    expect(failedPageGetRes.headers.get("set-cookie")).toBeNull();
    miniAppBundledAssetsPromiseHolder.current = Promise.resolve(null);
    const failedPageHeadRes: Response = await sendGateSecurityRequest({
      path: "/",
      method: "HEAD",
      headers: { Cookie: gateCookieHeader },
    });
    expect(failedPageHeadRes.status).toBe(500);
    miniAppBundledAssetsPromiseHolder.current = Promise.resolve(null);
    const failedChunkGetRes: Response = await sendGateSecurityRequest({
      path: "/chunk-probe.js",
      headers: { Cookie: gateCookieHeader },
    });
    expect(failedChunkGetRes.status).toBe(500);
    miniAppBundledAssetsPromiseHolder.current = Promise.resolve(null);
    const failedChunkHeadRes: Response = await sendGateSecurityRequest({
      path: "/chunk-probe.js",
      method: "HEAD",
      headers: { Cookie: gateCookieHeader },
    });
    expect(failedChunkHeadRes.status).toBe(500);
    miniAppBundledAssetsPromiseHolder.current = null;

    expect(readMiniAppPageGateCookie(new Request("http://127.0.0.1/"))).toBeNull();
    expect(
      readMiniAppPageGateCookie(
        new Request("http://127.0.0.1/", { headers: { Cookie: "other=1; another=2" } })
      )
    ).toBeNull();
    expect(hasMiniAppPageGateCookie(new Request("http://127.0.0.1/"))).toBeFalse();
    expect(readMiniAppPageGateCookie(new Request("http://127.0.0.1/"))).toBeNull();
    const bareCookieReq: Request = new Request("http://127.0.0.1/", {
      headers: { Cookie: `flag;  ${MINI_APP_PAGE_GATE_COOKIE_NAME} ; next=1` },
    });
    expect(readMiniAppPageGateCookie(bareCookieReq)).toBe("");
    expect(hasMiniAppPageGateCookie(bareCookieReq)).toBeTrue();
    const nearMissCookieReq: Request = new Request("http://127.0.0.1/", {
      headers: {
        Cookie: `x_${MINI_APP_PAGE_GATE_COOKIE_NAME}=1; ${MINI_APP_PAGE_GATE_COOKIE_NAME}_y=2;  ${MINI_APP_PAGE_GATE_COOKIE_NAME} = trimmed_val `,
      },
    });
    expect(readMiniAppPageGateCookie(nearMissCookieReq)).toBe("trimmed_val");
    expect(
      buildMiniAppPageGateSetCookieHeader(new Request("https://miniapp.example.com/"), baseMs)
    ).toContain("; Secure");

    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: gateSecretKey,
        superAdminUserId: SUPER_ADMIN_USER_ID,
        nowMs: baseMs + MINI_APP_SESSION_TTL_MS,
      })
    ).toBeTrue();
    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: gateSecretKey,
        superAdminUserId: SUPER_ADMIN_USER_ID,
        nowMs: baseMs + MINI_APP_SESSION_TTL_MS + 1,
      })
    ).toBeFalse();
    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: gateSecretKey,
        superAdminUserId: SUPER_ADMIN_USER_ID,
        nowMs: baseMs - MINI_APP_PAGE_GATE_CLOCK_SKEW_MS,
      })
    ).toBeTrue();
    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: gateSecretKey,
        superAdminUserId: SUPER_ADMIN_USER_ID,
        nowMs: baseMs - MINI_APP_PAGE_GATE_CLOCK_SKEW_MS - 1,
      })
    ).toBeFalse();

    const dotIndex: number = validGateToken.indexOf(".");
    const sigHex: string = validGateToken.slice(dotIndex + 1);
    const tamperedSig: string = `${sigHex.slice(0, -1)}${sigHex.endsWith("0") ? "1" : "0"}`;
    for (const invalidToken of [
      "",
      "no-dot-token",
      `${baseMs}.${sigHex}.extra`,
      `.${sigHex}`,
      `abc.${sigHex}`,
      `0.${sigHex}`,
      `${baseMs}.short`,
      `${baseMs}.${"z".repeat(64)}`,
      `${baseMs}.${tamperedSig}`,
    ]) {
      expect(
        verifyMiniAppPageGateToken({
          token: invalidToken,
          secretKey: gateSecretKey,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          nowMs: baseMs,
        })
      ).toBeFalse();
    }
    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: deriveMiniAppPageGateSecretKey("wrong-bot-token"),
        superAdminUserId: SUPER_ADMIN_USER_ID,
        nowMs: baseMs,
      })
    ).toBeFalse();
    expect(
      verifyMiniAppPageGateToken({
        token: validGateToken,
        secretKey: gateSecretKey,
        superAdminUserId: NON_ADMIN_USER_ID,
        nowMs: baseMs,
      })
    ).toBeFalse();

    expect(miniAppRejectHtmlHolder.current).not.toBeNull();
    await stopMiniAppServer();
    expect(miniAppRejectHtmlHolder.current).toBeNull();
  });
});
