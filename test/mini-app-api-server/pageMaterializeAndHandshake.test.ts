/**
 * Mini App 单页打包产物物化 fail-closed 防御与登录握手生命周期边界测试：
 * - `auth/handshake.ts`：Ed25519 生成失败清零 holder、过期握手清扫、畸形 `handshakeId` 拒绝；
 * - `handlers/page.ts`：密钥生成异常、非 32 字节公钥、临时静态服 404 / 资源非 2xx、缺失或残留占位符 fail-closed、
 *   物化途中服务端重启轮换签名密钥、并发单飞共享与 `GET`/`HEAD` 500 退避响应。
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import indexHtml from "../../packages/mini-app-frontend/index.html";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthHandshakes,
  miniAppBundledAssetsHolder,
  miniAppBundledAssetsPromiseHolder,
  miniAppInFlightHandshakeIds,
  miniAppRuntimeSigningKeyHolder,
} = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { MINI_APP_INIT_DATA_HEADER } = await import("../../packages/consts/miniApp");
const {
  MINI_APP_HANDSHAKE_TTL_MS,
  MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER,
} = await import("../../packages/consts/miniAppCrypto");
const { logger } = await import("../../packages/infra/logger");
const {
  acquireMiniAppAuthHandshake,
  clearMiniAppRuntimeSigningKeyPair,
  ensureMiniAppRuntimeSigningKeyPair,
  issueMiniAppAuthHandshake,
} = await import("../../packages/mini-app-api-server/auth/handshake");
const {
  handleGetMiniAppPageRoute,
  materializeBundledMiniAppAssets,
} = await import("../../packages/mini-app-api-server/handlers/page");

const originalFetch: typeof fetch = globalThis.fetch;

/**
 * 构造已签名的超级管理员页面入口请求。
 * @param method HTTP 请求方法。
 * @returns 带合法 `X-Telegram-Init-Data` 与回环地址的 `Request`。
 */
function buildAuthorizedPageRequest(method: "GET" | "HEAD" = "GET"): Request {
  const initData: string = buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1_000),
    user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin", username: "super_admin" },
  });
  return new Request("http://127.0.0.1:3000/", {
    method,
    headers: { [MINI_APP_INIT_DATA_HEADER]: initData },
  });
}

afterEach((): void => {
  globalThis.fetch = originalFetch;
  clearMiniAppRuntimeSigningKeyPair();
  miniAppBundledAssetsHolder.current = null;
  miniAppBundledAssetsPromiseHolder.current = null;
  miniAppAuthHandshakes.clear();
  miniAppInFlightHandshakeIds.clear();
  resetMiniAppTestDiskIOState();
});

describe("Mini App 握手生命周期与页面物化 fail-closed 边界", () => {
  test("auth/handshake：Ed25519 生成失败立即清空 holder 以便后续恢复，过期握手被清扫，畸形 handshakeId 被拒绝", async () => {
    // 1. generateKey 首次抛错时清空 miniAppRuntimeSigningKeyHolder.current，后续重试正常生成新密钥对。
    const genSpy = spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValueOnce(
      new Error("simulated ed25519 failure")
    );
    try {
      await expect(ensureMiniAppRuntimeSigningKeyPair()).rejects.toThrow(
        "simulated ed25519 failure"
      );
      expect(miniAppRuntimeSigningKeyHolder.current).toBeNull();
    } finally {
      genSpy.mockRestore();
    }

    const recovered = await ensureMiniAppRuntimeSigningKeyPair();
    expect(recovered.publicKeyBase64.length).toBeGreaterThan(0);
    expect(miniAppRuntimeSigningKeyHolder.current).not.toBeNull();

    // 2. 过期握手记录在下次签发或获取时被 purgeExpiredMiniAppAuthHandshakes 自动清理。
    const baseMs: number = 1_700_000_000_000;
    const oldOffer = await issueMiniAppAuthHandshake(baseMs);
    expect(miniAppAuthHandshakes.has(oldOffer.handshakeId)).toBeTrue();

    const freshOffer = await issueMiniAppAuthHandshake(baseMs + MINI_APP_HANDSHAKE_TTL_MS);
    expect(miniAppAuthHandshakes.has(oldOffer.handshakeId)).toBeFalse();
    expect(miniAppAuthHandshakes.has(freshOffer.handshakeId)).toBeTrue();

    // 3. 畸形 handshakeId 在进入查表与在途锁前直接返回 null。
    expect(acquireMiniAppAuthHandshake("not-a-valid-hex-id", baseMs + MINI_APP_HANDSHAKE_TTL_MS)).toBeNull();
    expect(acquireMiniAppAuthHandshake("", baseMs + MINI_APP_HANDSHAKE_TTL_MS)).toBeNull();
  });

  test("handlers/page：密钥生成失败或公钥非 32 字节时物化返回 null，GET/HEAD 入口返回 500", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      // 1. 运行期 Ed25519 生成失败 -> 物化失败，GET 返回 500 JSON，HEAD 返回 500 空体。
      const genSpy = spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValue(
        new Error("keygen unavailable")
      );
      try {
        expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
        expect(miniAppBundledAssetsHolder.current).toBeNull();

        const getRes: Response = await handleGetMiniAppPageRoute(
          buildAuthorizedPageRequest("GET"),
          indexHtml,
          false
        );
        expect(getRes.status).toBe(500);
        expect(await getRes.json()).toEqual({ error: "Internal server error" });

        const headRes: Response = await handleGetMiniAppPageRoute(
          buildAuthorizedPageRequest("HEAD"),
          indexHtml,
          true
        );
        expect(headRes.status).toBe(500);
        expect(await headRes.text()).toBe("");
      } finally {
        genSpy.mockRestore();
      }

      // 2. holder 持有非 32 字节（仅 3 字节）的畸形公钥 -> 拒绝物化并记错。
      const validPair = await ensureMiniAppRuntimeSigningKeyPair();
      miniAppRuntimeSigningKeyHolder.current = Promise.resolve({
        privateKey: validPair.privateKey,
        publicKeyBase64: "AAAA",
      });
      expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
      expect(miniAppBundledAssetsHolder.current).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        "Cannot materialize Mini App bundle without a valid Ed25519 signing public key."
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("handlers/page：覆盖临时服务器 404 回退、资源拉取失败、占位符缺失/残留、重启竞态与拉取异常 fail-closed", async () => {
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      // 1. 临时服务器未知路径触发 404 fallback 且入口 HTML 非 2xx 时返回 null。
      let fallbackStatus: number = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url: URL = input instanceof URL ? input : new URL(String(input));
        const probeRes: Response = await originalFetch(new URL("/unknown-probe", url.origin));
        fallbackStatus = probeRes.status;
        return probeRes;
      }) as typeof fetch;
      expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
      expect(fallbackStatus).toBe(404);

      // 2. 入口 HTML 引用的打包资源返回非 2xx 时返回 null。
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url: URL = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/_bundle") {
          return new Response('<script src="/missing.js"></script>', {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();

      // 3. JS 产物不包含公钥占位符时 fail-closed 返回 null。
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url: URL = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/_bundle") {
          return new Response('<script src="/app.js"></script><link href="/app.css">', {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/app.js") {
          return new Response("console.log('no-placeholder');", {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          });
        }
        return new Response("body{}", {
          status: 200,
          headers: { "Content-Type": "text/css" },
        });
      }) as typeof fetch;
      expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        "Bundled Mini App JS assets did not contain the Ed25519 signing public key placeholder."
      );

      // 4. 替换后若仍残留占位符（安全守卫命中）时 fail-closed 返回 null 且不写入缓存。
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url: URL = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/_bundle") {
          return new Response('<script src="/retained.js"></script>', {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(`const k = "${MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER}";`, {
          status: 200,
          headers: { "Content-Type": "text/javascript" },
        });
      }) as typeof fetch;
      const originalIncludes: (searchString: string, position?: number) => boolean =
        String.prototype.includes;
      const includesSpy = spyOn(String.prototype, "includes").mockImplementation(function(
        this: string,
        searchString: string,
        position?: number
      ): boolean {
        if (
          searchString === MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER &&
          this.startsWith('const k = "')
        ) {
          return true;
        }
        return originalIncludes.call(this, searchString, position);
      });
      try {
        expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
        expect(miniAppBundledAssetsHolder.current).toBeNull();
      } finally {
        includesSpy.mockRestore();
      }

      // 5. 物化途中发生服务端停启切换（签名密钥 holder 变更）时丢弃陈旧物化产物，不写入缓存。
      const restartedGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
        const url: URL = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === "/_bundle") {
          return new Response('<script src="/race.js"></script>', {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        clearMiniAppRuntimeSigningKeyPair();
        restartedGate.resolve();
        return new Response(`const k = "${MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER}";`, {
          status: 200,
          headers: { "Content-Type": "text/javascript" },
        });
      }) as typeof fetch;
      const [firstRace, secondRace] = await Promise.allSettled([
        materializeBundledMiniAppAssets(indexHtml),
        materializeBundledMiniAppAssets(indexHtml),
      ]);
      await restartedGate.promise;
      expect(firstRace).toEqual({ status: "fulfilled", value: null });
      expect(secondRace).toEqual({ status: "fulfilled", value: null });
      expect(miniAppBundledAssetsHolder.current).toBeNull();

      // 6. 物化期间 fetch 抛错时捕获记录并返回 null，同时清理在途单飞句柄。
      globalThis.fetch = (async (): Promise<never> => {
        throw new Error("simulated bundle fetch error");
      }) as unknown as typeof fetch;
      expect(await materializeBundledMiniAppAssets(indexHtml)).toBeNull();
      expect(miniAppBundledAssetsPromiseHolder.current).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
