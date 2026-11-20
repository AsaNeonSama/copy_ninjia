/**
 * Mini App 并发在途加密请求遇到滑动续期或登出时保持 `(token, CryptoKey)` 成对一致的专项测试。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { miniAppFetchJson } from "../../packages/mini-app-frontend/api/request";
import {
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_KEY_IDB_NAME,
  MINI_APP_SESSION_KEY_IDB_RECORD_KEY,
  MINI_APP_SESSION_KEY_IDB_STORE,
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { MINI_APP_SESSION_KEY_HEADER } from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import { sealRotatedMiniAppSessionKey } from "../../packages/mini-app-api-server/libs/crypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hasMiniAppSessionCryptoKey,
  hydrateMiniAppSessionFromStorage,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  buildMiniAppEnvelopeAad,
  decryptMiniAppPayload,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  isMiniAppEncryptedEnvelope,
} from "../../packages/mini-app-frontend/libs/crypto";
import { loadPersistedMiniAppSessionKey } from "../../packages/mini-app-frontend/libs/sessionKeyStorage";
import { setMiniAppServerSigningPublicKeyForTest } from "../../packages/mini-app-frontend/libs/signingKey";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import type {
  MiniAppIdbDatabaseLike,
  MiniAppIdbFactoryLike,
  MiniAppPersistedSessionKey,
} from "../../packages/mini-app-frontend/types/miniApp";
import {
  createInMemoryIdbFactory,
  seedTestMiniAppSession,
  TEST_ROTATED_SESSION_KEY,
  TEST_RUNTIME_SIGNING_KEY_PAIR,
  TEST_SESSION_KEY,
} from "./helpers/encryptedFetchMock";

const originalFetch: typeof fetch = globalThis.fetch;
const originalIndexedDb: unknown = (globalThis as { indexedDB?: unknown }).indexedDB;

beforeEach((): void => {
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "signed-superadmin-initdata" },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = createInMemoryIdbFactory();
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
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

describe("Mini App 并发在途加密请求的令牌与密钥世代一致性", () => {
  test("并发在途加密请求遇到滑动续期或登出时保持令牌与密钥成对一致，绝不回退覆盖更新一代凭据或复活已清除会话", async () => {
    const token0: string = "a".repeat(64);
    const token1: string = "b".repeat(64);
    const token2: string = "c".repeat(64);
    const key1Hex: string = TEST_ROTATED_SESSION_KEY;
    const key2Hex: string = "1122334455667788".repeat(4);
    seedTestMiniAppSession(token0, Date.now() + 60_000, TEST_SESSION_KEY);
    const cryptoKey0: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);
    const cryptoKey1: CryptoKey = await importMiniAppAesGcmKey(key1Hex);
    const cryptoKey2: CryptoKey = await importMiniAppAesGcmKey(key2Hex);

    let resolveSlowFirstGen!: (res: Response) => void;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ): Promise<Response> => {
      const url: URL = new URL(String(input), "https://mini.test/");
      const hdrs: Headers = new Headers(init?.headers);
      const sentToken: string = hdrs.get(MINI_APP_SESSION_HEADER) ?? "";

      if (url.pathname === "/api/fast-rotate") {
        expect(sentToken).toBe(token0);
        const sealed1: string = await sealRotatedMiniAppSessionKey(
          cryptoKey0,
          key1Hex,
          token1
        );
        const env = await encryptMiniAppEnvelope(
          cryptoKey0,
          JSON.stringify({ step: 1 }),
          buildMiniAppEnvelopeAad("GET", "/api/fast-rotate", "res")
        );
        return Response.json(env, {
          headers: {
            [MINI_APP_SESSION_HEADER]: token1,
            [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(
              Date.now() + MINI_APP_SESSION_TTL_MS
            ),
            [MINI_APP_SESSION_KEY_HEADER]: sealed1,
          },
        });
      }
      if (url.pathname === "/api/slow-previous") {
        expect(sentToken).toBe(token0);
        const bodyEnv: unknown = JSON.parse(String(init?.body ?? "{}"));
        expect(isMiniAppEncryptedEnvelope(bodyEnv)).toBeTrue();
        if (isMiniAppEncryptedEnvelope(bodyEnv)) {
          expect(
            JSON.parse(
              await decryptMiniAppPayload(
                cryptoKey0,
                bodyEnv,
                buildMiniAppEnvelopeAad("POST", "/api/slow-previous", "req")
              )
            )
          ).toEqual({
            op: "slow",
          });
        }
        return await new Promise<Response>(
          (resolve: (res: Response) => void): void => {
            resolveSlowFirstGen = resolve;
          }
        );
      }
      if (url.pathname === "/api/second-rotate") {
        expect(sentToken).toBe(token1);
        const sealed2: string = await sealRotatedMiniAppSessionKey(
          cryptoKey1,
          key2Hex,
          token2
        );
        const env = await encryptMiniAppEnvelope(
          cryptoKey1,
          JSON.stringify({ step: 2 }),
          buildMiniAppEnvelopeAad("GET", "/api/second-rotate", "res")
        );
        return Response.json(env, {
          headers: {
            [MINI_APP_SESSION_HEADER]: token2,
            [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(
              Date.now() + MINI_APP_SESSION_TTL_MS
            ),
            [MINI_APP_SESSION_KEY_HEADER]: sealed2,
          },
        });
      }
      if (url.pathname === "/api/verify-key2") {
        expect(sentToken).toBe(token2);
        return Response.json(
          await encryptMiniAppEnvelope(
            cryptoKey2,
            JSON.stringify({ verified: 2 }),
            buildMiniAppEnvelopeAad("GET", "/api/verify-key2", "res")
          )
        );
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }) as typeof fetch;

    const slowReq: Promise<{ readonly slow: boolean }> = miniAppFetchJson(
      "./api/slow-previous",
      { method: "POST", body: JSON.stringify({ op: "slow" }) }
    );
    const fastRes = await miniAppFetchJson<{ readonly step: number }>(
      "./api/fast-rotate"
    );
    expect(fastRes.step).toBe(1);
    expect(readMiniAppSessionToken()).toBe(token1);
    expect(hasMiniAppSessionCryptoKey()).toBeTrue();

    const secondRes = await miniAppFetchJson<{ readonly step: number }>(
      "./api/second-rotate"
    );
    expect(secondRes.step).toBe(2);
    expect(readMiniAppSessionToken()).toBe(token2);
    expect((await miniAppFetchJson<{ readonly verified: number }>("./api/verify-key2")).verified).toBe(2);

    const staleSealed1: string = await sealRotatedMiniAppSessionKey(
      cryptoKey0,
      key1Hex,
      token1
    );
    const slowEnv = await encryptMiniAppEnvelope(
      cryptoKey0,
      JSON.stringify({ slow: true }),
      buildMiniAppEnvelopeAad("POST", "/api/slow-previous", "res")
    );
    resolveSlowFirstGen(
      Response.json(slowEnv, {
        headers: {
          [MINI_APP_SESSION_HEADER]: token1,
          [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(
            Date.now() + MINI_APP_SESSION_TTL_MS
          ),
          [MINI_APP_SESSION_KEY_HEADER]: staleSealed1,
        },
      })
    );
    expect((await slowReq).slow).toBeTrue();
    expect(readMiniAppSessionToken()).toBe(token2);
    expect((await miniAppFetchJson<{ readonly verified: number }>("./api/verify-key2")).verified).toBe(2);

    // 登出清空凭据后，迟到的续期响应不会重新写入已注销会话。
    seedTestMiniAppSession(token0, Date.now() + 60_000, TEST_SESSION_KEY);
    let resolveAfterLogout!: (res: Response) => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted: Promise<void> = new Promise<void>(
      (resolve: () => void): void => {
        notifyFetchStarted = resolve;
      }
    );
    globalThis.fetch = ((): Promise<Response> =>
      new Promise<Response>((resolve: (res: Response) => void): void => {
        resolveAfterLogout = resolve;
        notifyFetchStarted();
      })) as unknown as typeof fetch;
    const inflightBeforeLogout: Promise<{ readonly slow: boolean }> =
      miniAppFetchJson("./api/slow-after-logout");
    await fetchStarted;
    clearMiniAppSessionToken();
    resolveAfterLogout(
      Response.json(
        await encryptMiniAppEnvelope(
          cryptoKey0,
          JSON.stringify({ slow: true }),
          buildMiniAppEnvelopeAad("GET", "/api/slow-after-logout", "res")
        ),
        {
          headers: {
            [MINI_APP_SESSION_HEADER]: token1,
            [MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(
              Date.now() + MINI_APP_SESSION_TTL_MS
            ),
            [MINI_APP_SESSION_KEY_HEADER]: staleSealed1,
          },
        }
      )
    );
    expect((await inflightBeforeLogout).slow).toBeTrue();
    expect(readMiniAppSessionToken()).toBe("");
    expect(hasMiniAppSessionCryptoKey()).toBeFalse();
  });

  test("IndexedDB 只保存同代 { token, cryptoKey }：新令牌已写入 sessionStorage 而新密钥未落盘时刷新恢复为上一代配对，裸 CryptoKey 记录视为缺失并自毁", async () => {
    const sessionStore: Map<string, string> = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (key: string): string | null => sessionStore.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        sessionStore.set(key, value);
      },
      removeItem: (key: string): void => {
        sessionStore.delete(key);
      },
    };
    const idbFactory: Readonly<MiniAppIdbFactoryLike> = createInMemoryIdbFactory();
    (globalThis as { indexedDB?: unknown }).indexedDB = idbFactory;
    /**
     * 只清空内存闭包而保留 sessionStorage 与 IndexedDB 夹具（等排队的 IndexedDB 清理任务在夹具卸下期间落空），模拟同一 WebView 内整页刷新。
     */
    const simulateReload = async (): Promise<void> => {
      const savedSessionStorage: unknown = (globalThis as { sessionStorage?: unknown }).sessionStorage;
      (globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
      clearMiniAppSessionToken();
      await Bun.sleep(10);
      (globalThis as { sessionStorage?: unknown }).sessionStorage = savedSessionStorage;
      (globalThis as { indexedDB?: unknown }).indexedDB = idbFactory;
    };
    try {
      const token0: string = "a".repeat(64);
      const token1: string = "b".repeat(64);
      const expiresAt: number = Date.now() + 60_000;
      setMiniAppSessionToken(token0, expiresAt, TEST_SESSION_KEY);
      await getMiniAppSessionCryptoKey();
      const persisted: Readonly<MiniAppPersistedSessionKey> | null =
        await loadPersistedMiniAppSessionKey();
      expect(persisted?.token).toBe(token0);
      expect(persisted?.cryptoKey.extractable).toBeFalse();

      // 轮换后新令牌已同步写入 sessionStorage，但新密钥尚未写入 IndexedDB 时页面刷新。
      sessionStore.set(MINI_APP_SESSION_STORAGE_KEY, JSON.stringify({ token: token1, expiresAt }));
      await simulateReload();
      await hydrateMiniAppSessionFromStorage();
      expect(readMiniAppSessionToken()).toBe(token0);
      const restoredKey: CryptoKey | null = await getMiniAppSessionCryptoKey();
      expect(restoredKey).not.toBeNull();
      const aad: Uint8Array<ArrayBuffer> = buildMiniAppEnvelopeAad("GET", "/api/status", "req");
      const sealedWithRestored = await encryptMiniAppEnvelope(restoredKey!, "{}", aad);
      expect(
        await decryptMiniAppPayload(await importMiniAppAesGcmKey(TEST_SESSION_KEY), sealedWithRestored, aad)
      ).toBe("{}");
      expect(JSON.parse(sessionStore.get(MINI_APP_SESSION_STORAGE_KEY)!).token).toBe(token0);

      // IndexedDB 中只有裸 CryptoKey（缺令牌配对）时视为缺失：水合自毁并清空 sessionStorage。
      const db: MiniAppIdbDatabaseLike = await new Promise<MiniAppIdbDatabaseLike>(
        (resolve: (value: MiniAppIdbDatabaseLike) => void): void => {
          const req = idbFactory.open(MINI_APP_SESSION_KEY_IDB_NAME, 1);
          req.onsuccess = (): void => resolve(req.result!);
        }
      );
      await new Promise<void>((resolve: () => void): void => {
        const put = db
          .transaction(MINI_APP_SESSION_KEY_IDB_STORE, "readwrite")
          .objectStore(MINI_APP_SESSION_KEY_IDB_STORE)
          .put(restoredKey, MINI_APP_SESSION_KEY_IDB_RECORD_KEY);
        put.onsuccess = (): void => resolve();
      });
      await simulateReload();
      await hydrateMiniAppSessionFromStorage();
      expect(readMiniAppSessionToken()).toBe("");
      expect(await getMiniAppSessionCryptoKey()).toBeNull();
      expect(sessionStore.has(MINI_APP_SESSION_STORAGE_KEY)).toBeFalse();
    } finally {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
