/**
 * Mini App 前端密钥吊销、登录过期与一层门禁拒绝的重定向测试：
 * - 会话密钥吊销/失步（400 `INVALID_ENCRYPTED_PAYLOAD`、损坏密文、明文 2xx 降级、损坏轮换密钥头）清除本地凭据并重定向回 `AuthGatePage`；
 * - 一层网关与 `initData` 过期拒绝（`EXPIRED_AUTH_DATE`、`FORBIDDEN_USER`、`INVALID_SIGNATURE`、`MISSING_INIT_DATA`）在已解锁态与登录页提交态均清除凭据并重定向至 `AccessDeniedPage`；
 * - 裸错误码、裸 HTTP 401 及过时请求序号竞态不吞掉鉴权重定向，且非会话业务校验错误（`INVALID_TOTP_CODE`、`TOTP_SETUP_EXPIRED`）保持停留在原页。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../../packages/mini-app-frontend/App";
import { downloadMiniAppGalleryImageByName } from "../../packages/mini-app-frontend/api/galleryDownload";
import { fetchMiniAppGalleryImageObjectUrl } from "../../packages/mini-app-frontend/api/galleryFile";
import { miniAppFetchJson } from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_SESSION_KEY_HEADER,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  buildMiniAppEnvelopeAad,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
} from "../../packages/mini-app-frontend/libs/crypto";
import { setMiniAppServerSigningPublicKeyForTest } from "../../packages/mini-app-frontend/libs/signingKey";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import type { MiniAppChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import type { MiniAppConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import { createGalleryStore } from "../../packages/mini-app-frontend/store/gallery";
import { createStatusStore } from "../../packages/mini-app-frontend/store/status";
import type { MiniAppStatusStore } from "../../packages/mini-app-frontend/store/status";
import { createTotpStore } from "../../packages/mini-app-frontend/store/totp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  createInMemoryIdbFactory,
  seedTestMiniAppSession,
  TEST_ROTATED_SESSION_KEY,
  TEST_RUNTIME_SIGNING_KEY_PAIR,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

type MockRouteHandler = (
  url: URL,
  init: RequestInit | undefined
) => Response | Promise<Response>;

const capturedRouteKeys: string[] = [];
const mockRoutes: Map<string, MockRouteHandler> = new Map<string, MockRouteHandler>();
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");
const originalFetch: typeof fetch = globalThis.fetch;
const originalIndexedDb: unknown = (globalThis as { indexedDB?: unknown }).indexedDB;

function registerRoute(key: string, handler: MockRouteHandler): void {
  mockRoutes.set(key, handler);
}

function jsonRes(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

function seedActiveSession(tokenHex: string): void {
  seedTestMiniAppSession(tokenHex, Date.now() + MINI_APP_SESSION_TTL_MS, TEST_SESSION_KEY);
  useMiniAppStore.setState({
    gateState: "unlocked",
    sessionExpiresAt: Date.now() + MINI_APP_SESSION_TTL_MS,
  });
}

function assertRenderedGateView(
  expectedView: "checking" | "denied" | "password" | "unlocked"
): void {
  const markup: string = renderToStaticMarkup(createElement(App));
  if (expectedView === "checking") {
    expect(markup).toBe("");
    return;
  }
  expect(markup.includes("cf-error-page")).toBe(expectedView === "denied");
  expect(markup.includes("auth-gate-card")).toBe(expectedView === "password");
  expect(markup.includes("app-shell")).toBe(expectedView === "unlocked");
}

beforeEach((): void => {
  capturedRouteKeys.length = 0;
  mockRoutes.clear();
  (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "valid-superadmin-initdata" },
  };
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
  globalThis.fetch = wrapEncryptedTestFetch(
    (
      url: URL,
      decryptedInit: RequestInit | undefined,
      rawInit: RequestInit | undefined
    ): Response | Promise<Response> => {
      const routeKey: string = `${(rawInit?.method ?? "GET").toUpperCase()} ${url.pathname}`;
      capturedRouteKeys.push(routeKey);
      const handler: MockRouteHandler | undefined = mockRoutes.get(routeKey);
      if (handler !== undefined) {
        return handler(url, decryptedInit);
      }
      return jsonRes({ error: `Unhandled route ${routeKey}` }, 404);
    }
  );
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
  setMiniAppServerSigningPublicKeyForTest(null);
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
});

describe("Mini App 密钥吊销、登录过期与门禁重定向", () => {
  test("会话密钥吊销/失步（400 INVALID_ENCRYPTED_PAYLOAD、损坏密文、明文 2xx 降级、损坏轮换密钥头）均清除本地凭据并重定向回 AuthGatePage", async () => {
    const invalidPayload400: MockRouteHandler = (): Response =>
      jsonRes({ error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE }, 400);
    for (const key of [
      "GET /api/status",
      "GET /api/mood",
      "GET /api/configs",
      "GET /api/configs/file",
      "POST /api/configs/save",
      "POST /api/configs/restart",
      "POST /api/gallery/upload",
      "GET /api/gallery/file",
      "GET /api/gallery/download",
    ]) {
      registerRoute(key, invalidPayload400);
    }

    // 1. 传输层直接收到 400 { error: "INVALID_ENCRYPTED_PAYLOAD" }（无 code 字段）时清除凭据并带 [PASSWORD_REQUIRED] 前缀。
    seedActiveSession("1".repeat(64));
    await expect(miniAppFetchJson("./api/status")).rejects.toThrow(
      `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`
    );
    expect(readMiniAppSessionToken()).toBe("");

    seedActiveSession("1".repeat(64));
    await expect(fetchMiniAppGalleryImageObjectUrl("revoked.png")).rejects.toThrow(
      `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`
    );
    expect(readMiniAppSessionToken()).toBe("");

    seedActiveSession("1".repeat(64));
    await expect(downloadMiniAppGalleryImageByName("revoked.png", "revoked.png")).rejects.toThrow(
      `[PASSWORD_REQUIRED] ${MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE}`
    );
    expect(readMiniAppSessionToken()).toBe("");

    // 2. ConfigsStore 加载、保存与静态配置重启遇到 400 INVALID_ENCRYPTED_PAYLOAD 均直接重定向至登录门禁（不再仅显示错误横幅与 Toast）。
    seedActiveSession("2".repeat(64));
    const configsStore: MiniAppConfigsStore = createConfigsStore();
    await configsStore.getState().loadInitialCatalogAndFile();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(useMiniAppStore.getState().passwordError).toBe(
      zh.serverNotice(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE)
    );
    expect(configsStore.getState().errorBanner).toBeNull();
    expect(readMiniAppSessionToken()).toBe("");
    assertRenderedGateView("password");

    seedActiveSession("2".repeat(64));
    configsStore.setState({
      scope: "dynamic",
      fileExists: true,
      loadedContent: '{"enabled": true}\n',
      draftContent: '{"enabled": false}\n',
      loading: false,
      errorBanner: null,
    });
    await configsStore.getState().saveCurrentConfig();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(configsStore.getState().errorBanner).toBeNull();
    expect(readMiniAppSessionToken()).toBe("");

    // 3. GalleryStore 多图上传首张命中 400 INVALID_ENCRYPTED_PAYLOAD 立即中止循环并跳转登录门禁。
    seedActiveSession("3".repeat(64));
    capturedRouteKeys.length = 0;
    const galleryStore = createGalleryStore();
    const fileA: File = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const fileB: File = new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" });
    await galleryStore.getState().uploadFiles([fileA, fileB]);
    expect(
      capturedRouteKeys.filter((key: string): boolean => key === "POST /api/gallery/upload")
    ).toHaveLength(1);
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");
    assertRenderedGateView("password");

    // 4. 后台静默轮询（loadMood / loadStatus(false)）遇到 400 INVALID_ENCRYPTED_PAYLOAD 同样立即跳转登录门禁。
    seedActiveSession("4".repeat(64));
    const statusStore: MiniAppStatusStore = createStatusStore();
    await statusStore.getState().loadMood();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    seedActiveSession("4".repeat(64));
    await statusStore.getState().loadStatus(false);
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    // 5. 原始响应层：密钥失步密文、明文 200 降级、损坏轮换密钥头 -> 不采纳篡改轮换头，清除凭据并重定向至 AuthGatePage。
    const savedWrappedFetch: typeof fetch = globalThis.fetch;
    try {
      const activeToken: string = "5".repeat(64);
      const forgedRotatedToken: string = "6".repeat(64);
      const validKey: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
      const wrongKey: CryptoKey = await importMiniAppAesGcmKey(TEST_ROTATED_SESSION_KEY);
      const wrongKeyEnvelope = await encryptMiniAppEnvelope(
        wrongKey,
        JSON.stringify({ ok: true }),
        buildMiniAppEnvelopeAad("GET", "/api/status", "res")
      );
      const validEnvelope = await encryptMiniAppEnvelope(
        validKey,
        JSON.stringify({ ok: true }),
        buildMiniAppEnvelopeAad("GET", "/api/status", "res")
      );

      const rawFailureResponses: readonly (readonly [string, () => Response])[] = [
        [
          "密钥失步密文（附带伪造轮换头）",
          (): Response =>
            Response.json(wrongKeyEnvelope, {
              status: 200,
              headers: {
                [MINI_APP_SESSION_HEADER]: forgedRotatedToken,
                [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + MINI_APP_SESSION_TTL_MS),
                [MINI_APP_SESSION_KEY_HEADER]: "invalid.sealed",
              },
            }),
        ],
        [
          "明文 200 降级响应",
          (): Response => Response.json({ ok: true }, { status: 200 }),
        ],
        [
          "损坏的 X-Mini-App-Session-Key 轮换头",
          (): Response =>
            Response.json(validEnvelope, {
              status: 200,
              headers: {
                [MINI_APP_SESSION_HEADER]: forgedRotatedToken,
                [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(Date.now() + MINI_APP_SESSION_TTL_MS),
                [MINI_APP_SESSION_KEY_HEADER]: "corrupted.rotation.header",
              },
            }),
        ],
      ];

      for (const [label, buildResponse] of rawFailureResponses) {
        seedActiveSession(activeToken);
        globalThis.fetch = (async (): Promise<Response> =>
          buildResponse()) as unknown as typeof fetch;
        const s: MiniAppStatusStore = createStatusStore();
        await s.getState().loadStatus(false);
        expect(`${label} -> ${useMiniAppStore.getState().gateState}`).toBe(`${label} -> password`);
        expect(readMiniAppSessionToken()).toBe("");
        expect(useMiniAppStore.getState().passwordError).toBe(
          zh.serverNotice(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE)
        );
        assertRenderedGateView("password");
      }
    } finally {
      globalThis.fetch = savedWrappedFetch;
    }
  });

  test("一层门禁拒绝（EXPIRED_AUTH_DATE / FORBIDDEN_USER 等）在已解锁态与登录提交态均清除凭据并重定向至 AccessDeniedPage，且不被后续重认证错误降级", async () => {
    const gatewayDenyCases: readonly (readonly [string, number])[] = [
      ["EXPIRED_AUTH_DATE", 401],
      ["FORBIDDEN_USER", 403],
      ["INVALID_SIGNATURE", 401],
      ["MISSING_INIT_DATA", 401],
    ];

    for (const [code, status] of gatewayDenyCases) {
      seedActiveSession("7".repeat(64));
      registerRoute("GET /api/chats", (): Response =>
        jsonRes({ ok: false, status, code, error: code }, status)
      );
      registerRoute("GET /api/auth/precheck", (): Response =>
        jsonRes({ ok: false, status, code, error: code }, status)
      );

      const chatsStore: MiniAppChatsStore = createChatsStore();
      await chatsStore.getState().loadChatList();
      expect(`${code} unlocked -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${code} unlocked -> checking`
      );
      expect(readMiniAppSessionToken()).toBe("");

      // 刚转入 checking 等待重预检时，同批在途请求晚到的重认证 401 也不得把门禁退回 password。
      useMiniAppStore.getState().notify("[PASSWORD_REQUIRED] SESSION_EXPIRED");
      expect(`${code} checking + trailing 401 -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${code} checking + trailing 401 -> checking`
      );

      await useMiniAppStore.getState().runAccessPrecheck();
      expect(`${code} precheck -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${code} precheck -> denied`
      );
      expect(useMiniAppStore.getState().deniedDiag?.code).toBe(code);
      assertRenderedGateView("denied");

      // 已进入 denied 时，滞后到达的 SESSION_EXPIRED / PASSWORD_REQUIRED 不得把门禁退回 password。
      useMiniAppStore.getState().notify("[PASSWORD_REQUIRED] SESSION_EXPIRED");
      expect(useMiniAppStore.getState().gateState).toBe("denied");
    }

    // 登录门禁页提交凭据时遇到 401 EXPIRED_AUTH_DATE 自动重预检并切至 AccessDeniedPage。
    useMiniAppStore.setState({
      gateState: "password",
      authMode: "password",
      passwordInput: "secret-pass",
      deniedDiag: null,
    });
    registerRoute("GET /api/auth/precheck", (): Response =>
      jsonRes({ ok: false, status: 401, code: "EXPIRED_AUTH_DATE", error: "EXPIRED_AUTH_DATE" }, 401)
    );
    await useMiniAppStore.getState().submitCredential();
    expect(useMiniAppStore.getState().gateState).toBe("denied");
    expect(useMiniAppStore.getState().deniedDiag?.code).toBe("EXPIRED_AUTH_DATE");
    assertRenderedGateView("denied");
  });

  test("裸错误码、裸 HTTP 401 与过时请求序号竞态均触发重定向；非会话校验错误（INVALID_TOTP_CODE / TOTP_SETUP_EXPIRED）保持停留在原页", async () => {
    // 1. 裸错误码直接调用 notify 时按分类重定向。
    for (const bareReauthCode of [
      "SESSION_EXPIRED",
      "PASSWORD_REQUIRED",
      MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
    ]) {
      seedActiveSession("8".repeat(64));
      useMiniAppStore.getState().notify(bareReauthCode, "warning");
      expect(`${bareReauthCode} -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${bareReauthCode} -> password`
      );
      expect(readMiniAppSessionToken()).toBe("");
    }
    for (const bareDeniedCode of [
      "EXPIRED_AUTH_DATE",
      "PASSWORD_LOCKED",
      "FORBIDDEN_USER",
      MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
    ]) {
      seedActiveSession("8".repeat(64));
      useMiniAppStore.getState().notify(bareDeniedCode, "danger");
      expect(`${bareDeniedCode} -> ${useMiniAppStore.getState().gateState}`).toBe(
        `${bareDeniedCode} -> checking`
      );
      expect(readMiniAppSessionToken()).toBe("");
    }

    // 2. 裸 HTTP 401（非 JSON 响应体）清除凭据并重定向回登录门禁。
    seedActiveSession("9".repeat(64));
    registerRoute("GET /api/chats", (): Response =>
      new Response("Unauthorized", { status: 401, headers: { "Content-Type": "text/plain" } })
    );
    const bare401ChatsStore: MiniAppChatsStore = createChatsStore();
    await bare401ChatsStore.getState().loadChatList();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    // 3. 过时请求序号竞态：loadChatList 在途期间本地翻页推进 listReqSeq 后，原请求返回 401 SESSION_EXPIRED 仍须重定向。
    seedActiveSession("a".repeat(64));
    const chatsGate: PromiseWithResolvers<Response> = Promise.withResolvers<Response>();
    const chatsEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    registerRoute("GET /api/chats", (): Promise<Response> => {
      chatsEntered.resolve();
      return chatsGate.promise;
    });
    const staleRaceChatsStore: MiniAppChatsStore = createChatsStore();
    const pendingList: Promise<void> = staleRaceChatsStore.getState().loadChatList();
    await chatsEntered.promise;
    staleRaceChatsStore.getState().setChatPage(2);
    chatsGate.resolve(jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401));
    await pendingList;
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    // 4. ConfigsPage 并发拉取：文件接口返回 500、目录接口返回 401 SESSION_EXPIRED 时仍优先重定向至登录门禁。
    seedActiveSession("b".repeat(64));
    registerRoute("GET /api/configs", (): Response =>
      jsonRes({ code: "PASSWORD_REQUIRED", error: "SESSION_EXPIRED" }, 401)
    );
    registerRoute("GET /api/configs/file", (): Response =>
      jsonRes({ error: "DISK_TEMPORARY_ERROR" }, 500)
    );
    const mixedConfigsStore: MiniAppConfigsStore = createConfigsStore();
    await mixedConfigsStore.getState().loadInitialCatalogAndFile();
    expect(useMiniAppStore.getState().gateState).toBe("password");
    expect(readMiniAppSessionToken()).toBe("");

    // 5. 回归保护：验证器页提交非法动态码或过期绑定码仅弹出提示，不清除会话也不重定向。
    const activeTotpToken: string = "c".repeat(64);
    seedActiveSession(activeTotpToken);
    const totpStore = createTotpStore();
    totpStore.setState({ codeInput: "123456" });
    registerRoute("POST /api/totp/enable", (): Response =>
      jsonRes(
        {
          ok: false,
          message: "INVALID_TOTP_CODE",
          status: { enabled: false, createdAt: null, maskedSecret: null },
        },
        400
      )
    );
    await totpStore.getState().verifyEnable();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    expect(readMiniAppSessionToken()).toBe(activeTotpToken);

    registerRoute("POST /api/totp/enable", (): Response =>
      jsonRes(
        {
          ok: false,
          message: "TOTP_SETUP_EXPIRED",
          status: { enabled: false, createdAt: null, maskedSecret: null },
        },
        400
      )
    );
    await totpStore.getState().verifyEnable();
    expect(useMiniAppStore.getState().gateState).toBe("unlocked");
    expect(readMiniAppSessionToken()).toBe(activeTotpToken);
  });
});
