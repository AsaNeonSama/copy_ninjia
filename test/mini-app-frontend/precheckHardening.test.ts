/**
 * Mini App 前端首屏预检安全加固专项测试：
 * - `#1`：`signatureMismatch` 遇到重启后旧前端包公钥不匹配时触发带 10 秒 `sessionStorage` 防环保护的单一 `location.reload()`；
 * - `#5`：Web Crypto API（`crypto.subtle` / `Ed25519` / `X25519`）缺失或不支持时拒绝重载并归一化为 `WEBCRYPTO_UNSUPPORTED` 三语提示。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { precheckMiniAppAccess } from "../../packages/mini-app-frontend/api/authPrecheck";
import {
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY,
  MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import {
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../../packages/mini-app-api-server/libs/handshakeCrypto";
import { setMiniAppServerSigningPublicKeyForTest } from "../../packages/mini-app-frontend/libs/signingKey";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import type { MiniAppAuthHandshakeOffer } from "../../packages/mini-app-frontend/types/miniApp";
import {
  createInMemoryIdbFactory,
  TEST_RUNTIME_SIGNING_KEY_PAIR,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

interface MemoryStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function createMemoryStorage(): MemoryStorage {
  const map: Map<string, string> = new Map<string, string>();
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

const SNAPSHOTTED_KEYS: readonly string[] = [
  "sessionStorage",
  "indexedDB",
  "Telegram",
  "location",
  "fetch",
];
const savedDescriptors: Map<string, PropertyDescriptor | undefined> = new Map<
  string,
  PropertyDescriptor | undefined
>();
let precheckHandler: (() => Response | Promise<Response>) | null = null;
let sessionStoreFixture: MemoryStorage = createMemoryStorage();

beforeEach((): void => {
  savedDescriptors.clear();
  for (const key of SNAPSHOTTED_KEYS) {
    savedDescriptors.set(key, Reflect.getOwnPropertyDescriptor(globalThis, key));
  }
  precheckHandler = null;
  sessionStoreFixture = createMemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: sessionStoreFixture,
  });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: createInMemoryIdbFactory(),
  });
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrapEncryptedTestFetch((): Response | Promise<Response> => {
      if (precheckHandler !== null) {
        return precheckHandler();
      }
      return Response.json({ error: "unhandled" }, { status: 404 });
    }),
  });
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  setMiniAppServerSigningPublicKeyForTest(null);
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
  for (const key of SNAPSHOTTED_KEYS) {
    const desc: PropertyDescriptor | undefined = savedDescriptors.get(key);
    if (desc !== undefined) {
      Object.defineProperty(globalThis, key, desc);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  savedDescriptors.clear();
});

describe("Mini App 前端预检签名防环与 Web Crypto 可用性守卫", () => {
  test("#1 precheck 遇到签名公钥不匹配时触发带 10 秒防环的单一 location.reload()；无 sessionStorage 时跳过重载，有效预检后清除防环标记", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };
    let reloadCount: number = 0;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        reload: (): void => {
          reloadCount += 1;
        },
      },
    });

    const otherServerPair = await generateMiniAppEd25519KeyPair();
    const xPair = await generateMiniAppX25519KeyPair();
    const mismatchedOfferWithoutSig: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "0123456789abcdef0123456789abcdef",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const mismatchedOffer: MiniAppAuthHandshakeOffer = {
      ...mismatchedOfferWithoutSig,
      signature: await signMiniAppHandshakeOffer(otherServerPair.privateKey, mismatchedOfferWithoutSig),
    };
    precheckHandler = (): Response =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: mismatchedOffer,
      });

    const firstMismatch = await precheckMiniAppAccess();
    expect(firstMismatch.ok).toBeFalse();
    if (!firstMismatch.ok) {
      expect(firstMismatch.diagnostics.code).toBe(MINI_APP_INVALID_HANDSHAKE_CODE);
    }
    expect(reloadCount).toBe(1);
    expect(sessionStoreFixture.getItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY)).not.toBeNull();

    // 10 秒防环窗口内再次遇到 signatureMismatch 不再重复 reload。
    const secondMismatch = await precheckMiniAppAccess();
    expect(secondMismatch.ok).toBeFalse();
    expect(reloadCount).toBe(1);

    // 超过 10 秒防环窗口后再次遇到 signatureMismatch 允许重新触发一次 reload。
    sessionStoreFixture.setItem(
      MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY,
      String(Date.now() - MINI_APP_SIGNING_KEY_RELOAD_WINDOW_MS - 1)
    );
    const expiredWindowMismatch = await precheckMiniAppAccess();
    expect(expiredWindowMismatch.ok).toBeFalse();
    expect(reloadCount).toBe(2);

    // 防环标记为畸形非时间戳字符串或非正数时视作无有效标记，允许重新触发 reload。
    for (const malformedTs of ["not-a-number", "0", "-500", ""]) {
      sessionStoreFixture.setItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY, malformedTs);
      const before: number = reloadCount;
      const malformedMismatch = await precheckMiniAppAccess();
      expect(malformedMismatch.ok).toBeFalse();
      expect(reloadCount).toBe(before + 1);
    }

    // 缺少 sessionStorage 时直接跳过 reload，避免无存储环境下死循环。
    Reflect.deleteProperty(globalThis, "sessionStorage");
    const beforeNoStorage: number = reloadCount;
    const noStorageMismatch = await precheckMiniAppAccess();
    expect(noStorageMismatch.ok).toBeFalse();
    expect(reloadCount).toBe(beforeNoStorage);

    // 恢复 sessionStorage 后若预检签发与当前注入公钥一致的合法握手，清除防环标记。
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: sessionStoreFixture,
    });
    const validOfferWithoutSig: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "fedcba9876543210fedcba9876543210",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const validOffer: MiniAppAuthHandshakeOffer = {
      ...validOfferWithoutSig,
      signature: await signMiniAppHandshakeOffer(TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey, validOfferWithoutSig),
    };
    precheckHandler = (): Response =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: validOffer,
      });
    const recovered = await precheckMiniAppAccess();
    expect(recovered.ok).toBeTrue();
    expect(sessionStoreFixture.getItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY)).toBeNull();
  });

  test("#5 Web Crypto API 缺失或抛出 NotSupportedError 时不触发重载并归一化为 WEBCRYPTO_UNSUPPORTED 多语言提示", async () => {
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: { initData: "valid-superadmin-initdata" },
    };
    let reloadCount: number = 0;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: {
        reload: (): void => {
          reloadCount += 1;
        },
      },
    });
    const xPair = await generateMiniAppX25519KeyPair();
    const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "abcdef0123456789abcdef0123456789",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const signedOffer: MiniAppAuthHandshakeOffer = {
      ...unsignedOffer,
      signature: await signMiniAppHandshakeOffer(TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey, unsignedOffer),
    };
    precheckHandler = (): Response =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: signedOffer,
      });

    const prevCryptoDesc: PropertyDescriptor | undefined =
      Reflect.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      // 1. crypto.subtle 完全缺失时直接阻断并进入 AccessDeniedPage（WEBCRYPTO_UNSUPPORTED）。
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {},
      });
      await useMiniAppStore.getState().runAccessPrecheck();
      expect(useMiniAppStore.getState().gateState).toBe("denied");
      expect(useMiniAppStore.getState().deniedDiag?.code).toBe(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
      expect(reloadCount).toBe(0);

      // 2. WebCrypto 导入 Ed25519 / X25519 抛出 NotSupportedError 时同样归一化为 WEBCRYPTO_UNSUPPORTED 且不重载。
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          subtle: {
            importKey: async (): Promise<never> => {
              throw new DOMException("Ed25519 unsupported", "NotSupportedError");
            },
            verify: async (): Promise<never> => {
              throw new DOMException("Ed25519 unsupported", "NotSupportedError");
            },
            generateKey: async (): Promise<never> => {
              throw new DOMException("X25519 unsupported", "NotSupportedError");
            },
          },
        },
      });
      const unsupportedPrecheck = await precheckMiniAppAccess();
      expect(unsupportedPrecheck.ok).toBeFalse();
      if (!unsupportedPrecheck.ok) {
        expect(unsupportedPrecheck.diagnostics.code).toBe(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
        expect(unsupportedPrecheck.diagnostics.error).toBe(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
      }
      expect(reloadCount).toBe(0);
    } finally {
      if (prevCryptoDesc !== undefined) {
        Object.defineProperty(globalThis, "crypto", prevCryptoDesc);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }

    for (const lang of ["zh", "en", "ja"] as const) {
      const notice: string = getMiniAppTranslations(lang).serverNotice(
        MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
      );
      expect(notice.trim().length).toBeGreaterThan(0);
      expect(notice).not.toBe(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
    }
  });
});
