import {
  MINI_APP_SESSION_KEY_IDB_NAME,
  MINI_APP_SESSION_KEY_IDB_RECORD_KEY,
  MINI_APP_SESSION_KEY_IDB_STORE,
  MINI_APP_SHA256_HEX_PATTERN,
} from "../consts/miniApp";
import type {
  MiniAppIdbDatabaseLike,
  MiniAppIdbFactoryLike,
  MiniAppIdbObjectStoreLike,
  MiniAppIdbRequestLike,
  MiniAppIdbTransactionLike,
  MiniAppPersistedSessionKey,
  TelegramWindow,
} from "../types/miniApp/host";
import { asPayloadRecord } from "./record";

/** 模块级串行队列尾节点：确保会话密钥 IndexedDB 写入与清理按调用顺序依次落盘，避免跨清扫乱序覆盖。 */
let sessionKeyStorageChain: Promise<void> = Promise.resolve();

/**
 * 判断 IndexedDB 读出的未知对象是否为结构兼容的 Web Crypto `CryptoKey`。
 * @param value IndexedDB 对象仓库返回的记录值。
 * @returns 为 `CryptoKey` 结构时返回 `true`。
 */
function isCryptoKeyLike(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "algorithm" in value &&
    "usages" in value
  );
}

/**
 * 在兼容受限隐私模式（`indexedDB` 缺省、拦截或抛异常）的前提下打开存储不可导出会话密钥的 IndexedDB 数据库。
 * @param idb 浏览器全局 `indexedDB` 工厂句柄。
 * @returns 打开的数据库句柄；不可用或被阻塞时返回 `null`。
 */
function openSessionKeyDatabase(
  idb: Readonly<MiniAppIdbFactoryLike>
): Promise<MiniAppIdbDatabaseLike | null> {
  return new Promise<MiniAppIdbDatabaseLike | null>((resolve: (db: MiniAppIdbDatabaseLike | null) => void): void => {
    let settled: boolean = false;
    const settle = (db: MiniAppIdbDatabaseLike | null): void => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    try {
      const req: MiniAppIdbRequestLike<MiniAppIdbDatabaseLike> = idb.open(
        MINI_APP_SESSION_KEY_IDB_NAME,
        1
      );
      req.onupgradeneeded = (): void => {
        const db: MiniAppIdbDatabaseLike | undefined = req.result;
        if (
          db !== undefined &&
          !db.objectStoreNames.contains(MINI_APP_SESSION_KEY_IDB_STORE)
        ) {
          db.createObjectStore(MINI_APP_SESSION_KEY_IDB_STORE);
        }
      };
      req.onsuccess = (): void => settle(req.result ?? null);
      req.onerror = (): void => settle(null);
      req.onblocked = (): void => settle(null);
    } catch (_error: unknown) {
      settle(null);
    }
  });
}

/**
 * 在单一 IndexedDB 事务内执行一次读写操作并确保完成后关闭数据库连接。
 * @param mode IndexedDB 事务模式。
 * @param execute 在指定 `objectStore` 上执行具体请求的回调。
 * @param fallback 数据库不可用或事务失败时的回退值。
 * @returns 事务结果或回退值。
 */
async function withSessionKeyObjectStore<T>(
  mode: "readonly" | "readwrite",
  execute: (
    store: MiniAppIdbObjectStoreLike,
    tx: MiniAppIdbTransactionLike,
    done: (value: T) => void
  ) => void,
  fallback: T
): Promise<T> {
  const tgWindow: TelegramWindow = globalThis;
  const idb: Readonly<MiniAppIdbFactoryLike> | undefined = tgWindow.indexedDB;
  if (idb === undefined) {
    return fallback;
  }
  const db: MiniAppIdbDatabaseLike | null = await openSessionKeyDatabase(idb);
  if (db === null) {
    return fallback;
  }
  try {
    return await new Promise<T>((resolve: (value: T) => void): void => {
      let settled: boolean = false;
      const settle = (value: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const tx: MiniAppIdbTransactionLike = db.transaction(
          MINI_APP_SESSION_KEY_IDB_STORE,
          mode
        );
        const store: MiniAppIdbObjectStoreLike = tx.objectStore(
          MINI_APP_SESSION_KEY_IDB_STORE
        );
        tx.onerror = (): void => settle(fallback);
        tx.onabort = (): void => settle(fallback);
        execute(store, tx, settle);
      } catch (_error: unknown) {
        settle(fallback);
      }
    });
  } finally {
    try {
      db.close();
    } catch (_error: unknown) {
      // 忽略关闭数据库连接时的非致命异常
    }
  }
}

/**
 * 将一次 IndexedDB 持久化读/写/删任务排入模块级单链串行队列执行。
 * @param task 待执行的异步存储任务。
 * @param fallback 任务异常时的安全回退值。
 * @returns 任务返回值。
 */
function enqueueSessionKeyStorageTask<T>(
  task: () => Promise<T>,
  fallback: T
): Promise<T> {
  const next: Promise<T> = sessionKeyStorageChain.then(task, task).catch(
    (): T => fallback
  );
  sessionKeyStorageChain = next.then(
    (): void => undefined,
    (): void => undefined
  );
  return next;
}

/**
 * 校验 IndexedDB 读出的记录是否为 `{ token, cryptoKey }` 配对结构。
 * @param value IndexedDB 对象仓库返回的记录值。
 * @returns 结构合法时返回配对记录，否则返回 `null`。
 */
function parsePersistedSessionKey(
  value: unknown
): Readonly<MiniAppPersistedSessionKey> | null {
  const record: Record<string, unknown> = asPayloadRecord(value);
  const token: unknown = record.token;
  const cryptoKey: unknown = record.cryptoKey;
  if (
    typeof token !== "string" ||
    !MINI_APP_SHA256_HEX_PATTERN.test(token) ||
    !isCryptoKeyLike(cryptoKey)
  ) {
    return null;
  }
  return { token, cryptoKey };
}

/**
 * 将会话令牌与其不可导出的 `AES-GCM` `CryptoKey` 作为同一条记录结构化克隆写入 IndexedDB（不暴露任何明文十六进制密钥给 Web Storage），
 * 使恢复时读到的令牌与密钥恒为同代配对。
 * @param token 与 `cryptoKey` 同代的 64 位十六进制会话令牌。
 * @param cryptoKey 当前会话不可导出的 `AES-GCM` `CryptoKey`。
 */
export function persistMiniAppSessionKey(
  token: string,
  cryptoKey: CryptoKey
): Promise<void> {
  return enqueueSessionKeyStorageTask(async (): Promise<void> => {
    await withSessionKeyObjectStore<void>(
      "readwrite",
      (
        store: MiniAppIdbObjectStoreLike,
        tx: MiniAppIdbTransactionLike,
        done: (value: void) => void
      ): void => {
        const record: Readonly<MiniAppPersistedSessionKey> = { token, cryptoKey };
        const req: MiniAppIdbRequestLike<unknown> = store.put(
          record,
          MINI_APP_SESSION_KEY_IDB_RECORD_KEY
        );
        tx.oncomplete = (): void => done(undefined);
        req.onerror = (): void => done(undefined);
      },
      undefined
    );
  }, undefined);
}

/**
 * 从 IndexedDB 读取先前持久化的 `{ token, cryptoKey }` 配对记录（用于页面刷新恢复会话）。
 * @returns 读取并校验通过的配对记录；缺失、结构不符、损坏或 IndexedDB 不可用时返回 `null`。
 */
export function loadPersistedMiniAppSessionKey(): Promise<Readonly<MiniAppPersistedSessionKey> | null> {
  return enqueueSessionKeyStorageTask(
    (): Promise<Readonly<MiniAppPersistedSessionKey> | null> =>
      withSessionKeyObjectStore<Readonly<MiniAppPersistedSessionKey> | null>(
        "readonly",
        (
          store: MiniAppIdbObjectStoreLike,
          _tx: MiniAppIdbTransactionLike,
          done: (value: Readonly<MiniAppPersistedSessionKey> | null) => void
        ): void => {
          const req: MiniAppIdbRequestLike<unknown> = store.get(
            MINI_APP_SESSION_KEY_IDB_RECORD_KEY
          );
          req.onsuccess = (): void => {
            done(parsePersistedSessionKey(req.result));
          };
          req.onerror = (): void => done(null);
        },
        null
      ),
    null
  );
}

/**
 * 从 IndexedDB 彻底清除已保存的 `{ token, cryptoKey }` 配对记录（登出、过期或凭据失配时调用）。
 */
export function clearPersistedMiniAppSessionKey(): Promise<void> {
  return enqueueSessionKeyStorageTask(async (): Promise<void> => {
    await withSessionKeyObjectStore<void>(
      "readwrite",
      (
        store: MiniAppIdbObjectStoreLike,
        tx: MiniAppIdbTransactionLike,
        done: (value: void) => void
      ): void => {
        const req: MiniAppIdbRequestLike<unknown> = store.delete(
          MINI_APP_SESSION_KEY_IDB_RECORD_KEY
        );
        tx.oncomplete = (): void => done(undefined);
        req.onerror = (): void => done(undefined);
      },
      undefined
    );
  }, undefined);
}
