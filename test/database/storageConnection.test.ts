/**
 * 共享存储数据库的连接边界（packages/database/interact/connection.ts）：
 * 1. 缺库时拒绝打开，不顺手创建空库。
 * 2. 写连接额外核对文件与父目录（经软链接指向的库文件被拒，普通连接照常打开并可写入）。
 * 3. 只读连接能读既有库，写入由 SQLite 拒绝。
 * 4. `enableStorageDatabaseWal` 将 journal 模式写进库文件，按回读 PRAGMA 判定。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { createStorageDatabase } from
  "../../packages/database/interact/migration";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

let temporaryRoot: string | null = null;

function tempRoot(): string {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-connection-"));
  return temporaryRoot;
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("共享存储数据库连接", () => {
  test("建库目标是悬空软链接时拒绝创建，不顺着链接在目标处建库", async () => {
    const root: string = tempRoot();
    const path: string = join(root, "storage.sqlite");
    const target: string = join(root, "elsewhere.sqlite");
    symlinkSync(target, path);
    expect(() => createStorageDatabase(path)).toThrow("target already exists; refusing to overwrite it.");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("数据库文件不存在时拒绝打开，且指明要先初始化", async () => {
    const path: string = join(tempRoot(), "storage.sqlite");

    expect(() => openStorageDatabase({ path })).toThrow(
      `${path}: database file is missing; initialize current storage first.`
    );
    // 拒绝之后不得顺手创建空库。
    expect(await Bun.file(path).exists()).toBeFalse();
  });

  test("写连接额外核对文件与父目录，两者都可用时照常打开", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    const database: StorageDatabase = openStorageDatabase({
      path,
      requireWritableAccess: true,
    });
    try {
      expect(() => database.$client.run("CREATE TABLE probe (value INTEGER);")).not.toThrow();
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("写连接拒绝经软链接指向的库文件，普通连接照常顺着链接打开", () => {
    const root: string = tempRoot();
    const target: string = join(root, "storage.sqlite");
    const linked: string = join(root, "linked.sqlite");
    createStorageDatabase(target);
    symlinkSync(target, linked);

    expect(() => openStorageDatabase({ path: linked, requireWritableAccess: true }))
      .toThrow("a regular file without symbolic-link indirection");
    closeStorageDatabase(openStorageDatabase({ path: linked }));
  });

  test("enableStorageDatabaseWal 打开 WAL 并归还连接", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    enableStorageDatabaseWal(path);

    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      const [mode] = database.$client
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
        .all();
      expect(mode?.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("只读连接可以打开并读取既有库，写入被 SQLite 拒绝", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    const database: StorageDatabase = openStorageDatabase({ path, readonly: true });
    try {
      expect(database.$client.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").all()).toHaveLength(1);
      expect(() => database.$client.run("CREATE TABLE probe (value INTEGER);")).toThrow("readonly");
    } finally {
      closeStorageDatabase(database);
    }
  });
});
