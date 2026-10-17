/** Disk I/O Worker 干净停机关库：残余写提交与失败重试 timer 的撤销、TRUNCATE checkpoint、关库与关库后的写入忽略。 */

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { IDENTITY_WRITE_FLUSH_INTERVAL_MS } from "../../../packages/consts/identityStorage";
import { STORAGE_WRITE_MAX_FAILURES } from "../../../packages/consts/diskIO/business";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import {
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
  storageDatabaseClosed,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import { handleIdentityPolicyWrite } from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { closeStorageDatabaseForShutdown } from "../../../packages/workers/diskIO/storageDatabase/shutdown";
import { clearStorageBusinessTables } from "../../../scripts/fixtures/storageDatabase";
import {
  hydrateStorageDatabase,
  whitelistWrite,
} from "../../helpers/storageDatabaseHydration";
import type {
  IdentityStoragePersistedReply,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";

const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

function whitelistRowCount(): number {
  const database: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
  try {
    return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM permission_list;").get()!.count;
  } finally {
    database.close();
  }
}

beforeEach((): void => {
  acknowledgements.length = 0;
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  hydrateStorageDatabase();
});

afterEach((): void => {
  resetStorageDatabaseCache();
  jest.useRealTimers();
});

describe("干净停机关库", (): void => {
  test("先提交残余写再 checkpoint 关库：WAL/SHM 删除，主库重开后行数一致", async (): Promise<void> => {
    handleIdentityPolicyWrite(whitelistWrite(7, 1), reply);
    expect(pendingWhitelistWrites.size).toBe(1);
    expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-wal`).exists()).toBeTrue();

    expect(closeStorageDatabaseForShutdown(reply)).toEqual({ committed: true, checkpointBusy: false });

    expect(acknowledgements.map((ack: IdentityStoragePersistedReply): unknown => ack.writes))
      .toEqual([[{ table: "whitelist", id: 7, revision: 1 }]]);
    expect(storageDatabaseHandle.current).toBeNull();
    expect(storageDatabaseClosed.current).toBeTrue();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-wal`).exists()).toBeFalse();
    expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-shm`).exists()).toBeFalse();
    expect(whitelistRowCount()).toBe(1);
  });

  test("另一条读连接持有读事务时 checkpoint 报 busy，关库照常完成，WAL 留在原地", async (): Promise<void> => {
    const reader: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
    try {
      reader.run("BEGIN;");
      reader.query("SELECT COUNT(*) FROM permission_list;").get();
      handleIdentityPolicyWrite(whitelistWrite(8, 1), reply);

      expect(closeStorageDatabaseForShutdown(reply)).toEqual({ committed: true, checkpointBusy: true });

      expect(storageDatabaseHandle.current).toBeNull();
      expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-wal`).exists()).toBeTrue();
      reader.run("COMMIT;");
    } finally {
      reader.close();
    }
    expect(whitelistRowCount()).toBe(1);
  });

  test("残余写提交失败留下的重试 timer 在关库时撤销，checkpoint 与关库照常完成", (): void => {
    const consoleError: ReturnType<typeof spyOn> = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      const timersBefore: number = jest.getTimerCount();
      // 非法 JSON 让统一事务在 jsonb() 编码处失败；连接本身完好，checkpoint 仍能执行。
      pendingWhitelistWrites.set(10, { data: "{", revision: 1 });

      expect(closeStorageDatabaseForShutdown(reply)).toEqual({ committed: false, checkpointBusy: false });

      // 提交失败排下的退避重试已撤销：关库后不留任何挂起的提交 timer。
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(storageWriteFlushTimer.current).toBeNull();
      expect(jest.getTimerCount()).toBe(timersBefore);
      expect(storageDatabaseHandle.current).toBeNull();
      expect(storageDatabaseClosed.current).toBeTrue();

      // 推进远超首档退避的时长也不会再触发提交或日志；最终值留在缓冲，不回 ACK。
      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS * (STORAGE_WRITE_MAX_FAILURES + 1));
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(pendingWhitelistWrites.get(10)?.revision).toBe(1);
      expect(acknowledgements).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
    expect(whitelistRowCount()).toBe(0);
  });

  test("关库后不再提交，也不再挂定时提交", (): void => {
    closeStorageDatabaseForShutdown(reply);
    pendingWhitelistWrites.set(9, { data: whitelistWrite(9, 1).data, revision: 1 });

    expect(flushStorageDatabase(reply)).toBeFalse();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(acknowledgements).toEqual([]);
  });

  test("未加载时关库按生命周期错误抛出", (): void => {
    resetStorageDatabaseCache();
    expect((): unknown => closeStorageDatabaseForShutdown(reply)).toThrow("database must be loaded before use");
    expect(storageDatabaseClosed.current).toBeFalse();
  });
});
