/**
 * Mini App 前端凭据水合、IndexedDB 故障回退、预检竞态边界与临时 ECDH/Ed25519 密钥错误分支测试：
 * - `libs/sessionKeyStorage.ts`：IndexedDB 缺省、`open` 抛错/报错/阻塞、`transaction` 抛错、事务中断、`db.close()` 异常与损坏记录容错；
 * - `libs/credentials.ts`：Web Storage 读写抛错、非法令牌/密钥、密钥导入失败、并发水合单飞与世代切变作废；
 * - `api/authPrecheck.ts`：诊断字段解析、存储异常防循环守卫、在途被新会话取代与过期握手拒绝；
 * - `libs/handshakeCrypto.ts` & `libs/signingKey.ts`：低阶全零共享密钥、WebCrypto 缺失/`NotSupportedError` 与各类畸形入参拒绝。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair as generateServerX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../../packages/mini-app-api-server/libs/handshakeCrypto";
import { precheckMiniAppAccess } from "../../packages/mini-app-frontend/api/authPrecheck";
import {
  MINI_APP_SESSION_STORAGE_KEY,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../packages/mini-app-frontend/consts/miniAppCrypto";
import {
  clearMiniAppSessionToken,
  getMiniAppSessionCryptoKey,
  hydrateMiniAppSessionFromStorage,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
  restoreMiniAppSessionCryptoKey,
  setMiniAppSessionToken,
} from "../../packages/mini-app-frontend/libs/credentials";
import {
  bytesToBase64,
  importMiniAppAesGcmKey,
} from "../../packages/mini-app-frontend/libs/crypto";
import {
  deriveClientMiniAppHandshakeKeys,
  generateClientMiniAppX25519KeyPair,
  verifyMiniAppHandshakeOfferDetailed,
} from "../../packages/mini-app-frontend/libs/handshakeCrypto";
import {
  clearPersistedMiniAppSessionKey,
  loadPersistedMiniAppSessionKey,
  persistMiniAppSessionKey,
} from "../../packages/mini-app-frontend/libs/sessionKeyStorage";
import {
  getMiniAppServerSigningPublicKey,
  setMiniAppServerSigningPublicKeyForTest,
} from "../../packages/mini-app-frontend/libs/signingKey";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppIdbDatabaseLike,
  MiniAppIdbFactoryLike,
  MiniAppIdbObjectStoreLike,
  MiniAppIdbRequestLike,
  MiniAppIdbTransactionLike,
} from "../../packages/mini-app-frontend/types/miniApp";
import {
  createInMemoryIdbFactory,
  TEST_ROTATED_SESSION_KEY,
  TEST_RUNTIME_SIGNING_KEY_PAIR,
  TEST_SESSION_KEY,
} from "./helpers/encryptedFetchMock";

const SNAPSHOT_KEYS: readonly string[] = [
  "sessionStorage",
  "localStorage",
  "indexedDB",
  "location",
  "Telegram",
  "fetch",
];
const savedDescriptors: Map<string, PropertyDescriptor | undefined> = new Map<
  string,
  PropertyDescriptor | undefined
>();

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function createMemoryStorage(): {
  readonly map: Map<string, string>;
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
} {
  const map: Map<string, string> = new Map<string, string>();
  return {
    map,
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

beforeEach((): void => {
  savedDescriptors.clear();
  for (const key of SNAPSHOT_KEYS) {
    savedDescriptors.set(key, Reflect.getOwnPropertyDescriptor(globalThis, key));
  }
  setGlobal("sessionStorage", createMemoryStorage());
  setGlobal("localStorage", createMemoryStorage());
  setGlobal("indexedDB", createInMemoryIdbFactory());
  setGlobal("Telegram", { WebApp: { initData: "valid-init-data" } });
  setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
  clearMiniAppSessionToken();
});

afterEach((): void => {
  setMiniAppServerSigningPublicKeyForTest(null);
  clearMiniAppSessionToken();
  for (const key of SNAPSHOT_KEYS) {
    const desc: PropertyDescriptor | undefined = savedDescriptors.get(key);
    if (desc !== undefined) {
      Object.defineProperty(globalThis, key, desc);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
  savedDescriptors.clear();
});

describe("Mini App 前端会话存储与凭据水合异常分支", () => {
  test("sessionKeyStorage 覆盖 indexedDB 缺失、open/tx/close 异常、事件报错与损坏记录回退", async () => {
    const validToken: string = "a".repeat(64);
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);

    // 1. indexedDB 缺失时安全返回回退值。
    Reflect.deleteProperty(globalThis, "indexedDB");
    expect(await loadPersistedMiniAppSessionKey()).toBeNull();
    await expect(persistMiniAppSessionKey(validToken, cryptoKey)).resolves.toBeUndefined();
    await expect(clearPersistedMiniAppSessionKey()).resolves.toBeUndefined();

    const makeIdbReq = <TResult>(result?: TResult): MiniAppIdbRequestLike<TResult> => ({
      result,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    });
    const makeIdbTx = (
      objectStore: (name: string) => MiniAppIdbObjectStoreLike
    ): MiniAppIdbTransactionLike => ({
      objectStore,
      oncomplete: null,
      onerror: null,
      onabort: null,
    });

    // 2. idb.open 同步抛错时返回 null。
    setGlobal("indexedDB", {
      open: (): never => {
        throw new Error("idb open denied");
      },
    } as unknown as MiniAppIdbFactoryLike);
    expect(await loadPersistedMiniAppSessionKey()).toBeNull();

    // 3. idb.open 触发 onerror / onblocked 时均返回 null。
    for (const failEvent of ["onerror", "onblocked"] as const) {
      setGlobal("indexedDB", {
        open: (): MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> => {
          const req: MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> = makeIdbReq();
          queueMicrotask((): void => {
            req[failEvent]?.();
          });
          return req;
        },
      } as unknown as MiniAppIdbFactoryLike);
      expect(await loadPersistedMiniAppSessionKey()).toBeNull();
    }

    // 4. db.transaction 抛错与 db.close 抛错均安全降级为回退值且不阻塞后续队列。
    let closeThrows: number = 0;
    const txThrowDb: MiniAppIdbDatabaseLike = {
      objectStoreNames: { contains: (): boolean => true },
      createObjectStore: (): void => {},
      transaction: (): never => {
        throw new Error("tx failed");
      },
      close: (): void => {
        closeThrows += 1;
        throw new Error("close failed");
      },
    };
    setGlobal("indexedDB", {
      open: (): MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> => {
        const req: MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> = makeIdbReq(txThrowDb);
        queueMicrotask((): void => {
          req.onsuccess?.();
        });
        return req;
      },
    } as unknown as MiniAppIdbFactoryLike);
    expect(await loadPersistedMiniAppSessionKey()).toBeNull();
    expect(closeThrows).toBe(1);

    // 5. tx.onerror / tx.onabort 与 req.onerror 触发回退，损坏记录解析为 null。
    for (const mode of ["txError", "txAbort", "reqError", "corrupt"] as const) {
      const customDb: MiniAppIdbDatabaseLike = {
        objectStoreNames: { contains: (): boolean => true },
        createObjectStore: (): void => {},
        transaction: (): MiniAppIdbTransactionLike => {
          const tx: MiniAppIdbTransactionLike = makeIdbTx(
            (): MiniAppIdbObjectStoreLike => ({
              put: (): MiniAppIdbRequestLike<unknown> => {
                const putReq: MiniAppIdbRequestLike<unknown> = makeIdbReq();
                queueMicrotask((): void => {
                  if (mode === "reqError") putReq.onerror?.();
                  else if (mode === "txError") tx.onerror?.();
                  else if (mode === "txAbort") tx.onabort?.();
                  else tx.oncomplete?.();
                });
                return putReq;
              },
              get: (): MiniAppIdbRequestLike<unknown> => {
                const getReq: MiniAppIdbRequestLike<unknown> = makeIdbReq({
                  token: "bad",
                  cryptoKey: null,
                });
                queueMicrotask((): void => {
                  if (mode === "reqError") getReq.onerror?.();
                  else if (mode === "txError") tx.onerror?.();
                  else if (mode === "txAbort") tx.onabort?.();
                  else getReq.onsuccess?.();
                });
                return getReq;
              },
              delete: (): MiniAppIdbRequestLike<unknown> => {
                const delReq: MiniAppIdbRequestLike<unknown> = makeIdbReq();
                queueMicrotask((): void => {
                  if (mode === "reqError") delReq.onerror?.();
                  else if (mode === "txError") tx.onerror?.();
                  else if (mode === "txAbort") tx.onabort?.();
                  else tx.oncomplete?.();
                });
                return delReq;
              },
            })
          );
          return tx;
        },
        close: (): void => {},
      };
      setGlobal("indexedDB", {
        open: (): MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> => {
          const req: MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> = makeIdbReq(customDb);
          queueMicrotask((): void => {
            req.onsuccess?.();
          });
          return req;
        },
      } as unknown as MiniAppIdbFactoryLike);
      expect(await loadPersistedMiniAppSessionKey()).toBeNull();
      await expect(persistMiniAppSessionKey(validToken, cryptoKey)).resolves.toBeUndefined();
      await expect(clearPersistedMiniAppSessionKey()).resolves.toBeUndefined();
    }

    // 6. 恢复正常 IDB 后串行队列仍可正常读写与清理。
    setGlobal("indexedDB", createInMemoryIdbFactory());
    await persistMiniAppSessionKey(validToken, cryptoKey);
    const loaded = await loadPersistedMiniAppSessionKey();
    expect(loaded?.token).toBe(validToken);
    expect(loaded?.cryptoKey).toBe(cryptoKey);
  });

  test("credentials 覆盖受限存储抛错、损坏 JSON、非法令牌/密钥、导入失败与并发水合世代竞态", async () => {
    const tokenA: string = "1".repeat(64);
    const tokenB: string = "2".repeat(64);
    const keyA: CryptoKey = await importMiniAppAesGcmKey(TEST_SESSION_KEY);

    // 1. sessionStorage / localStorage 所有操作抛错时不崩溃。
    const throwingStorage = {
      getItem: (): never => {
        throw new Error("storage read denied");
      },
      setItem: (): never => {
        throw new Error("storage write denied");
      },
      removeItem: (): never => {
        throw new Error("storage remove denied");
      },
    };
    setGlobal("sessionStorage", throwingStorage);
    setGlobal("localStorage", throwingStorage);
    await hydrateMiniAppSessionFromStorage();
    expect(readMiniAppSessionToken()).toBe("");
    setMiniAppSessionToken(tokenA, Number.NaN, TEST_SESSION_KEY);
    expect(readMiniAppSessionToken()).toBe(tokenA);
    expect(readMiniAppSessionExpiresAt()).toBeGreaterThan(Date.now());
    expect(readMiniAppSessionExpiresAt()).toBeLessThanOrEqual(Date.now() + MINI_APP_SESSION_TTL_MS + 100);
    clearMiniAppSessionToken();

    // 2. 损坏的 sessionStorage JSON 在水合时视为无效并清除。
    const memSession = createMemoryStorage();
    setGlobal("sessionStorage", memSession);
    setGlobal("localStorage", createMemoryStorage());
    memSession.setItem(MINI_APP_SESSION_STORAGE_KEY, "{broken-json");
    await hydrateMiniAppSessionFromStorage();
    expect(memSession.getItem(MINI_APP_SESSION_STORAGE_KEY)).toBeNull();

    // 3. 非法令牌、非法十六进制密钥、无密钥更新不匹配令牌、restoreMiniAppSessionCryptoKey 非法令牌均自清。
    setMiniAppSessionToken("invalid-token", Date.now() + 60_000, TEST_SESSION_KEY);
    expect(readMiniAppSessionToken()).toBe("");
    setMiniAppSessionToken(tokenA, Date.now() + 60_000, "not-hex-key");
    expect(readMiniAppSessionToken()).toBe("");
    setMiniAppSessionToken(tokenA, Date.now() + 60_000, TEST_SESSION_KEY);
    setMiniAppSessionToken(tokenB, Date.now() + 60_000);
    expect(readMiniAppSessionToken()).toBe("");
    restoreMiniAppSessionCryptoKey("bad-token", Date.now() + 60_000, keyA);
    expect(readMiniAppSessionToken()).toBe("");

    // 4. crypto.subtle.importKey 抛错时清理当前会话并返回 null；导入在途切换世代时返回 null。
    const importSpy = spyOn(globalThis.crypto.subtle, "importKey").mockRejectedValueOnce(
      new Error("import key failed")
    );
    try {
      setMiniAppSessionToken(tokenA, Date.now() + 60_000, TEST_SESSION_KEY);
      expect(await getMiniAppSessionCryptoKey()).toBeNull();
      expect(readMiniAppSessionToken()).toBe("");
    } finally {
      importSpy.mockRestore();
    }

    const importGate: PromiseWithResolvers<CryptoKey> = Promise.withResolvers<CryptoKey>();
    const pendingImportSpy = spyOn(globalThis.crypto.subtle, "importKey").mockImplementationOnce(
      (): Promise<CryptoKey> => importGate.promise
    );
    try {
      setMiniAppSessionToken(tokenA, Date.now() + 60_000, TEST_SESSION_KEY);
      const pendingKeyRead: Promise<CryptoKey | null> = getMiniAppSessionCryptoKey();
      clearMiniAppSessionToken();
      importGate.resolve(keyA);
      expect(await pendingKeyRead).toBeNull();
    } finally {
      pendingImportSpy.mockRestore();
    }

    // 5. 并发 hydrateMiniAppSessionFromStorage 共享同一在途句柄，且在途写入新登录会话时不回写旧水合结果。
    const idbGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const gatedDb: MiniAppIdbDatabaseLike = {
      objectStoreNames: { contains: (): boolean => true },
      createObjectStore: (): void => {},
      transaction: (): MiniAppIdbTransactionLike => {
        const tx: MiniAppIdbTransactionLike = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore: (): MiniAppIdbObjectStoreLike => ({
            put: (): MiniAppIdbRequestLike<unknown> => {
              queueMicrotask((): void => {
                tx.oncomplete?.();
              });
              return { onsuccess: null, onerror: null };
            },
            delete: (): MiniAppIdbRequestLike<unknown> => {
              queueMicrotask((): void => {
                tx.oncomplete?.();
              });
              return { onsuccess: null, onerror: null };
            },
            get: (): MiniAppIdbRequestLike<unknown> => {
              const req: MiniAppIdbRequestLike<unknown> = {
                result: { token: tokenA, cryptoKey: keyA },
                onsuccess: null,
                onerror: null,
              };
              void idbGate.promise.then((): void => {
                req.onsuccess?.();
              });
              return req;
            },
          }),
        };
        return tx;
      },
      close: (): void => {},
    };
    setGlobal("indexedDB", {
      open: (): MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> => {
        const req: MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> = {
          result: gatedDb,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask((): void => {
          req.onsuccess?.();
        });
        return req;
      },
    } as unknown as MiniAppIdbFactoryLike);
    memSession.setItem(
      MINI_APP_SESSION_STORAGE_KEY,
      JSON.stringify({ token: tokenA, expiresAt: Date.now() + 60_000 })
    );
    const h1: Promise<void> = hydrateMiniAppSessionFromStorage();
    const h2: Promise<void> = hydrateMiniAppSessionFromStorage();
    setMiniAppSessionToken(tokenB, Date.now() + 120_000, TEST_ROTATED_SESSION_KEY);
    idbGate.resolve();
    const hydrateResults = await Promise.allSettled([h1, h2]);
    expect(hydrateResults.every((res): boolean => res.status === "fulfilled")).toBeTrue();
    expect(readMiniAppSessionToken()).toBe(tokenB);
  });
});

describe("Mini App 前端预检与握手加密边界分支", () => {
  test("authPrecheck 覆盖诊断字段、存储异常防环守卫、在途新会话接管与过期握手拒绝", async () => {
    let reloadCalls: number = 0;
    setGlobal("location", {
      reload: (): void => {
        reloadCalls += 1;
      },
    });

    // 1. 403 响应携带 remainingAttempts / remainingMinutes 时完整透传到 diagnostics。
    setGlobal("fetch", async (): Promise<Response> =>
      Response.json(
        {
          ok: false,
          code: "PASSWORD_LOCKED",
          error: "locked",
          remainingAttempts: 0,
          remainingMinutes: 15,
        },
        { status: 403 }
      ));
    const denied = await precheckMiniAppAccess();
    expect(denied.ok).toBeFalse();
    if (!denied.ok) {
      expect(denied.diagnostics.remainingAttempts).toBe(0);
      expect(denied.diagnostics.remainingMinutes).toBe(15);
    }

    // 2. signatureMismatch 下 sessionStorage.getItem / setItem 抛错时不触发死循环重载；
    //    验签成功时 sessionStorage.removeItem 抛错也被吞掉。
    const otherEd = await generateMiniAppEd25519KeyPair();
    const xPair = await generateServerX25519KeyPair();
    const mismatchUnsigned: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "0123456789abcdef0123456789abcdef",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const mismatchOffer: MiniAppAuthHandshakeOffer = {
      ...mismatchUnsigned,
      signature: await signMiniAppHandshakeOffer(otherEd.privateKey, mismatchUnsigned),
    };
    setGlobal("sessionStorage", {
      getItem: (): never => {
        throw new Error("getItem blocked");
      },
      setItem: (): never => {
        throw new Error("setItem blocked");
      },
      removeItem: (): never => {
        throw new Error("removeItem blocked");
      },
    });
    setGlobal("fetch", async (): Promise<Response> =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: mismatchOffer,
      }));
    const mismatchRes = await precheckMiniAppAccess();
    expect(mismatchRes.ok).toBeFalse();
    expect(reloadCalls).toBe(0);

    // 3. 签名合法但 expiresAt 已过期的握手被拒（INVALID_HANDSHAKE）。
    const expiredUnsigned: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "11112222333344445555666677778888",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() - 10_000,
    };
    const expiredOffer: MiniAppAuthHandshakeOffer = {
      ...expiredUnsigned,
      signature: await signMiniAppHandshakeOffer(
        TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey,
        expiredUnsigned
      ),
    };
    setGlobal("fetch", async (): Promise<Response> =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: expiredOffer,
      }));
    const expiredRes = await precheckMiniAppAccess();
    expect(expiredRes.ok).toBeFalse();
    if (!expiredRes.ok) {
      expect(expiredRes.diagnostics.code).toBe(MINI_APP_INVALID_HANDSHAKE_CODE);
    }

    // 4. 合法握手成功时即便 sessionStorage.removeItem 抛错也正常通过。
    const validUnsigned: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: "88887777666655554444333322221111",
      serverPublicKey: xPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const validOffer: MiniAppAuthHandshakeOffer = {
      ...validUnsigned,
      signature: await signMiniAppHandshakeOffer(
        TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey,
        validUnsigned
      ),
    };
    setGlobal("fetch", async (): Promise<Response> =>
      Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        handshake: validOffer,
      }));
    const validRes = await precheckMiniAppAccess();
    expect(validRes.ok).toBeTrue();

    // 5. precheck 在途期间被新登录会话取代（supersededByNewerSession），响应返回 sessionValid: true 时保留新会话与更晚到期时间。
    const memSession = createMemoryStorage();
    memSession.setItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY, String(Date.now()));
    setGlobal("sessionStorage", memSession);
    const oldToken: string = "a".repeat(64);
    const newerToken: string = "b".repeat(64);
    const newerExpiresAt: number = Date.now() + 180_000;
    const serverExpiresAt: number = Date.now() + 60_000;
    setMiniAppSessionToken(oldToken, serverExpiresAt, TEST_SESSION_KEY);
    await getMiniAppSessionCryptoKey();
    setGlobal("fetch", async (): Promise<Response> => {
      setMiniAppSessionToken(newerToken, newerExpiresAt, TEST_ROTATED_SESSION_KEY);
      await getMiniAppSessionCryptoKey();
      return Response.json({
        ok: true,
        ttlMs: MINI_APP_SESSION_TTL_MS,
        totpEnabled: false,
        authMode: "password",
        sessionValid: true,
        sessionExpiresAt: serverExpiresAt,
      });
    });
    const supersededRes = await precheckMiniAppAccess();
    expect(supersededRes.ok).toBeTrue();
    if (supersededRes.ok) {
      expect(supersededRes.sessionValid).toBeTrue();
      expect(supersededRes.sessionExpiresAt).toBe(newerExpiresAt);
    }
    expect(readMiniAppSessionToken()).toBe(newerToken);
    expect(memSession.getItem(MINI_APP_SIGNING_KEY_RELOAD_STORAGE_KEY)).toBeNull();
  });

  test("handshakeCrypto 与 signingKey 覆盖低阶全零共享密钥、WEBCRYPTO_UNSUPPORTED 与异常输入分支", async () => {
    const clientPair = await generateClientMiniAppX25519KeyPair();
    const serverPair = await generateServerX25519KeyPair();
    const validHandshakeId: string = "abcdef0123456789abcdef0123456789";

    // 1. signingKey：非 32 字节公钥与通用 importKey 异常均抛出 INVALID_HANDSHAKE。
    setMiniAppServerSigningPublicKeyForTest("AAAA");
    await expect(getMiniAppServerSigningPublicKey()).rejects.toThrow(
      MINI_APP_INVALID_HANDSHAKE_CODE
    );
    setMiniAppServerSigningPublicKeyForTest(TEST_RUNTIME_SIGNING_KEY_PAIR.publicKeyBase64);
    const importErrSpy = spyOn(globalThis.crypto.subtle, "importKey").mockRejectedValueOnce(
      new Error("generic import failure")
    );
    try {
      await expect(getMiniAppServerSigningPublicKey()).rejects.toThrow(
        MINI_APP_INVALID_HANDSHAKE_CODE
      );
    } finally {
      importErrSpy.mockRestore();
    }

    // 2. verifyMiniAppHandshakeOfferDetailed：字段缺失、非法 Base64、verify 通用异常均返回 INVALID_HANDSHAKE。
    expect(await verifyMiniAppHandshakeOfferDetailed({ handshakeId: validHandshakeId })).toEqual({
      ok: false,
      code: MINI_APP_INVALID_HANDSHAKE_CODE,
      signatureMismatch: false,
    });
    expect(
      await verifyMiniAppHandshakeOfferDetailed({
        handshakeId: validHandshakeId,
        serverPublicKey: "%%%not-base64%%%",
        expiresAt: Date.now() + 60_000,
        signature: "%%%not-base64%%%",
      })
    ).toEqual({
      ok: false,
      code: MINI_APP_INVALID_HANDSHAKE_CODE,
      signatureMismatch: false,
    });
    const validUnsigned: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
      handshakeId: validHandshakeId,
      serverPublicKey: serverPair.publicKeyBase64,
      expiresAt: Date.now() + 60_000,
    };
    const validSigned: MiniAppAuthHandshakeOffer = {
      ...validUnsigned,
      signature: await signMiniAppHandshakeOffer(
        TEST_RUNTIME_SIGNING_KEY_PAIR.privateKey,
        validUnsigned
      ),
    };
    const verifyErrSpy = spyOn(globalThis.crypto.subtle, "verify").mockRejectedValueOnce(
      new Error("verify exploded")
    );
    try {
      expect(await verifyMiniAppHandshakeOfferDetailed(validSigned)).toEqual({
        ok: false,
        code: MINI_APP_INVALID_HANDSHAKE_CODE,
        signatureMismatch: false,
      });
    } finally {
      verifyErrSpy.mockRestore();
    }

    // 3. generateClientMiniAppX25519KeyPair：非 KeyPair 返回、NotSupportedError、通用错误与缺少 subtle。
    const badGenSpy = spyOn(globalThis.crypto.subtle, "generateKey").mockResolvedValueOnce(
      {} as unknown as CryptoKeyPair
    );
    try {
      await expect(generateClientMiniAppX25519KeyPair()).rejects.toThrow(
        MINI_APP_INVALID_HANDSHAKE_CODE
      );
    } finally {
      badGenSpy.mockRestore();
    }
    const unsupportedGenSpy = spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValueOnce(
      new DOMException("X25519 unsupported", "NotSupportedError")
    );
    try {
      await expect(generateClientMiniAppX25519KeyPair()).rejects.toThrow(
        MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
      );
    } finally {
      unsupportedGenSpy.mockRestore();
    }
    const genericGenSpy = spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValueOnce(
      new Error("generic keygen err")
    );
    try {
      await expect(generateClientMiniAppX25519KeyPair()).rejects.toThrow("generic keygen err");
    } finally {
      genericGenSpy.mockRestore();
    }

    // 4. deriveClientMiniAppHandshakeKeys：非法 handshakeId / Base64 / 长度 / 低阶全零共享密钥 / NotSupportedError / 通用异常。
    await expect(
      deriveClientMiniAppHandshakeKeys({
        clientPrivateKey: clientPair.privateKey,
        serverPublicKeyBase64: serverPair.publicKeyBase64,
        clientPublicKeyBase64: clientPair.publicKeyBase64,
        handshakeId: "bad-id",
      })
    ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);

    await expect(
      deriveClientMiniAppHandshakeKeys({
        clientPrivateKey: clientPair.privateKey,
        serverPublicKeyBase64: "%%%bad%%%",
        clientPublicKeyBase64: clientPair.publicKeyBase64,
        handshakeId: validHandshakeId,
      })
    ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);

    await expect(
      deriveClientMiniAppHandshakeKeys({
        clientPrivateKey: clientPair.privateKey,
        serverPublicKeyBase64: bytesToBase64(new Uint8Array(32)),
        clientPublicKeyBase64: clientPair.publicKeyBase64,
        handshakeId: validHandshakeId,
      })
    ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);

    // deriveBits 返回全零 32 字节（模拟低阶点共享密钥）-> 拒绝并抛 INVALID_HANDSHAKE。
    const zeroSecretSpy = spyOn(globalThis.crypto.subtle, "deriveBits").mockResolvedValueOnce(
      new ArrayBuffer(32)
    );
    try {
      await expect(
        deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: clientPair.privateKey,
          serverPublicKeyBase64: serverPair.publicKeyBase64,
          clientPublicKeyBase64: clientPair.publicKeyBase64,
          handshakeId: validHandshakeId,
        })
      ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);
    } finally {
      zeroSecretSpy.mockRestore();
    }

    const unsupportedDeriveSpy = spyOn(globalThis.crypto.subtle, "deriveBits").mockRejectedValueOnce(
      new DOMException("derive unsupported", "NotSupportedError")
    );
    try {
      await expect(
        deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: clientPair.privateKey,
          serverPublicKeyBase64: serverPair.publicKeyBase64,
          clientPublicKeyBase64: clientPair.publicKeyBase64,
          handshakeId: validHandshakeId,
        })
      ).rejects.toThrow(MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE);
    } finally {
      unsupportedDeriveSpy.mockRestore();
    }

    const genericDeriveSpy = spyOn(globalThis.crypto.subtle, "deriveBits").mockRejectedValueOnce(
      new Error("derive exploded")
    );
    try {
      await expect(
        deriveClientMiniAppHandshakeKeys({
          clientPrivateKey: clientPair.privateKey,
          serverPublicKeyBase64: serverPair.publicKeyBase64,
          clientPublicKeyBase64: clientPair.publicKeyBase64,
          handshakeId: validHandshakeId,
        })
      ).rejects.toThrow(MINI_APP_INVALID_HANDSHAKE_CODE);
    } finally {
      genericDeriveSpy.mockRestore();
    }

    // 5. crypto.subtle 缺失时 getMiniAppServerSigningPublicKey 与 generateClientMiniAppX25519KeyPair 均抛 WEBCRYPTO_UNSUPPORTED。
    const prevCryptoDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "crypto"
    );
    try {
      setGlobal("crypto", {});
      await expect(getMiniAppServerSigningPublicKey()).rejects.toThrow(
        MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
      );
      await expect(generateClientMiniAppX25519KeyPair()).rejects.toThrow(
        MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE
      );
    } finally {
      if (prevCryptoDesc !== undefined) {
        Object.defineProperty(globalThis, "crypto", prevCryptoDesc);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });
});
