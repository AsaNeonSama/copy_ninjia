import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { storageDatabaseSchema } from
  "../../../packages/database/schema/storage";
import {
  pendingBlocklistWrites,
  pendingTemporaryAdBypassWrites,
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import { TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD } from "../../../packages/consts/temporaryAdBypass";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../../packages/consts/whitelist";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import { closeStorageDatabase, openStorageDatabase } from "../../../packages/database/interact/connection";
import { createStorageDatabase } from "../../../packages/database/interact/migration";
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../../packages/database/interact/transaction";
import {
  readIdentityIdPage,
  readIdentityPolicies,
} from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";
import type {
  IdentityIdPageReadReply,
  IdentityPoliciesReadReply,
} from "../../../packages/types/diskIO";
import type { IdentityPolicyTable } from "../../../packages/types/identityPolicy";
import type { PendingIdentityPolicyWrite } from "../../../packages/types/identityStorage";
import type { TemporaryAdBypassActivity } from "../../../packages/types/states/temporaryAdBypass";
import type { StoredTemporaryAdBypassActivity } from "../../../packages/types/temporaryAdBypass";

/** 一张名单表的游标页读取夹具：SQLite 表名、未提交写缓冲与读页入口。 */
interface IdPageTable {
  readonly label: string;
  readonly sqlTable: string;
  readonly pending: Map<number, PendingIdentityPolicyWrite>;
  readonly read: (requestId: number, afterId: number | null) => IdentityIdPageReadReply;
}

/**
 * 按名单读取一页主键。
 * @param table 名单。
 * @returns 以请求 ID 与游标读页的入口。
 */
function readPageOf(table: IdentityPolicyTable): IdPageTable["read"] {
  return (requestId: number, afterId: number | null): IdentityIdPageReadReply =>
    readIdentityIdPage({ type: "readIdentityIdPage", requestId, table, afterId });
}

const TABLES: readonly IdPageTable[] = [
  { label: "黑名单", sqlTable: "blocklist_entries", pending: pendingBlocklistWrites, read: readPageOf("blocklist") },
  { label: "白名单", sqlTable: "permission_list", pending: pendingWhitelistWrites, read: readPageOf("whitelist") },
];

function seedTable(database: StorageDatabase, sqlTable: string, count: number): void {
  const insert = database.$client.prepare(
    `INSERT INTO ${sqlTable} (id, data) VALUES (?, x'00');`
  );
  database.$client.transaction((): void => {
    for (let id: number = 1; id <= count; id++) insert.run(id);
  })();
}

beforeEach(() => {
  resetStorageDatabaseCache();
  const client: Database = new Database(":memory:", { strict: true });
  for (const { sqlTable } of TABLES) {
    client.run(`CREATE TABLE ${sqlTable} (id INTEGER PRIMARY KEY, data BLOB NOT NULL);`);
  }
  storageDatabaseHandle.current = drizzle({
    client,
    schema: storageDatabaseSchema,
  });
});

afterEach(() => {
  resetStorageDatabaseCache();
});

for (const table of TABLES) {
  describe(`Disk I/O ${table.label}稳定游标页`, () => {
    test("单页载荷受硬顶，按唯一主键续读且不重复，只读本表", () => {
      const database: StorageDatabase = storageDatabaseHandle.current!;
      seedTable(database, table.sqlTable, BLOCKLIST_SWEEP_PAGE_SIZE + 2);

      const first = table.read(1, null);
      expect(first.type).toBe("identityIdPageRead");
      expect(first.error).toBeUndefined();
      expect(first.page?.ids).toHaveLength(BLOCKLIST_SWEEP_PAGE_SIZE);
      expect(first.page?.ids[0]).toBe(1);
      expect(first.page?.nextCursor).toBe(BLOCKLIST_SWEEP_PAGE_SIZE);
      expect(first.page?.done).toBeFalse();

      const second = table.read(2, first.page!.nextCursor);
      expect(second.page).toEqual({
        ids: [BLOCKLIST_SWEEP_PAGE_SIZE + 1, BLOCKLIST_SWEEP_PAGE_SIZE + 2],
        nextCursor: BLOCKLIST_SWEEP_PAGE_SIZE + 2,
        done: true,
      });

      for (const other of TABLES) {
        if (other !== table) expect(other.read(3, null).page).toEqual({ ids: [], nextCursor: null, done: true });
      }
    });

    test("事务内删除和新增只叠加到有界候选页，另一表的缓冲不参与", () => {
      const database: StorageDatabase = storageDatabaseHandle.current!;
      seedTable(database, table.sqlTable, BLOCKLIST_SWEEP_PAGE_SIZE + 1);
      table.pending.set(1, { data: null, revision: 1 });
      table.pending.set(BLOCKLIST_SWEEP_PAGE_SIZE + 2, {
        data: "{}",
        revision: 2,
      });
      for (const other of TABLES) {
        if (other !== table) other.pending.set(BLOCKLIST_SWEEP_PAGE_SIZE + 3, { data: "{}", revision: 3 });
      }

      const reply = table.read(3, null);
      expect(reply.page?.ids).toHaveLength(BLOCKLIST_SWEEP_PAGE_SIZE);
      expect(reply.page?.ids[0]).toBe(2);
      expect(reply.page?.ids.at(-1)).toBe(BLOCKLIST_SWEEP_PAGE_SIZE + 1);
      expect(reply.page?.done).toBeFalse();

      const tail = table.read(4, reply.page!.nextCursor);
      expect(tail.page).toEqual({
        ids: [BLOCKLIST_SWEEP_PAGE_SIZE + 2],
        nextCursor: BLOCKLIST_SWEEP_PAGE_SIZE + 2,
        done: true,
      });
    });

    test("事务内待写增量超过硬顶时以错误回执拒绝扩页，不抛出 Worker", () => {
      for (let id: number = 1; id <= BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES + 1; id++) {
        table.pending.set(id, { data: "{}", revision: id });
      }

      expect(table.read(4, null)).toEqual({
        type: "identityIdPageRead",
        requestId: 4,
        error: expect.stringContaining("refusing to expand a sweep page"),
      });
    });

    test("非法游标以错误回执结算对应请求", () => {
      const page = table.read(5, 1.5);
      expect(page.type).toBe("identityIdPageRead");
      expect(page.requestId).toBe(5);
      expect(page.error).toEqual(expect.any(String));
      expect(page.page).toBeUndefined();
    });
  });
}

describe("Disk I/O 批量身份策略读取", () => {
  let temporaryRoot: string;
  let migratedDatabase: StorageDatabase;

  function whitelistData(name: string): string {
    return encodeWhitelistEntryData({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: name, lastName: "", username: "" },
    });
  }

  function blocklistData(name: string): string {
    return encodeBlocklistEntryData({
      meta: { firstName: name, lastName: "", username: "" },
      blockedAt: "2026/01/01 00:00:00",
    });
  }

  function bypassActivity(extraMessages: number): TemporaryAdBypassActivity {
    return {
      adBypass: true,
      adBypassGrantedAt: 1_000,
      qualifiedDays: 1,
      sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1 + extraMessages,
      countedAt: 3_000,
      qualifiedAt: 2_000,
    };
  }

  function storedBypass(id: number, extraMessages: number): StoredTemporaryAdBypassActivity {
    return { id, ...bypassActivity(extraMessages) };
  }

  beforeEach((): void => {
    resetStorageDatabaseCache();
    temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-diskio-identity-read-"));
    const dbPath: string = join(temporaryRoot, "storage.sqlite");
    createStorageDatabase(dbPath);
    migratedDatabase = openStorageDatabase({ path: dbPath });
    storageDatabaseHandle.current = migratedDatabase;

    commitStorageDatabaseChanges(prepareStorageDatabaseWriter(migratedDatabase), {
      whitelist: new Map([
        [1, { data: whitelistData("白1-已提交") }],
        [2, { data: whitelistData("白2-待覆盖") }],
        [3, { data: whitelistData("白3-待删除") }],
      ]),
      blocklist: new Map([
        [11, { data: blocklistData("黑11-已提交") }],
        [12, { data: blocklistData("黑12-待覆盖") }],
        [13, { data: blocklistData("黑13-待删除") }],
      ]),
      temporaryAdBypass: new Map([
        [21, { activity: bypassActivity(1), revision: 1 }],
        [22, { activity: bypassActivity(2), revision: 1 }],
        [23, { activity: bypassActivity(3), revision: 1 }],
      ]),
      removals: new Map(),
      chatStates: new Map(),
      chatQa: new Map(),
      aiContexts: new Map(),
    });
  });

  afterEach((): void => {
    resetStorageDatabaseCache();
    closeStorageDatabase(migratedDatabase);
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test("非法身份主键以错误回执结算对应请求", () => {
    const policies: IdentityPoliciesReadReply = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 6,
      ids: [7, 0],
    });
    expect(policies.type).toBe("identityPoliciesRead");
    expect(policies.requestId).toBe(6);
    expect(policies.error).toEqual(expect.any(String));
    expect(policies.whitelist).toBeUndefined();
  });

  test("空批次返回三张空列表，不报错", () => {
    const reply: IdentityPoliciesReadReply = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 7,
      ids: [],
    });
    expect(reply).toEqual({
      type: "identityPoliciesRead",
      requestId: 7,
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [],
    });
  });

  test("单 ID 路径叠加三张表的未提交新增、覆盖与删除", () => {
    const updatedWhitelist: string = whitelistData("白2-事务覆盖");
    pendingWhitelistWrites.set(2, { data: updatedWhitelist, revision: 2 });
    pendingWhitelistWrites.set(3, { data: null, revision: 2 });
    const newBlocklist: string = blocklistData("黑99-事务新增");
    pendingBlocklistWrites.set(99, { data: newBlocklist, revision: 1 });
    pendingTemporaryAdBypassWrites.set(22, { activity: bypassActivity(50), revision: 2 });
    pendingTemporaryAdBypassWrites.set(23, { activity: null, revision: 2 });

    expect(readIdentityPolicies({ type: "readIdentityPolicies", requestId: 8, ids: [2] })).toEqual({
      type: "identityPoliciesRead",
      requestId: 8,
      whitelist: [[2, updatedWhitelist]],
      blocklist: [],
      temporaryAdBypass: [],
    });
    expect(readIdentityPolicies({ type: "readIdentityPolicies", requestId: 9, ids: [3] })).toEqual({
      type: "identityPoliciesRead",
      requestId: 9,
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [],
    });
    expect(readIdentityPolicies({ type: "readIdentityPolicies", requestId: 10, ids: [99] })).toEqual({
      type: "identityPoliciesRead",
      requestId: 10,
      whitelist: [],
      blocklist: [[99, newBlocklist]],
      temporaryAdBypass: [],
    });
    expect(readIdentityPolicies({ type: "readIdentityPolicies", requestId: 11, ids: [22] })).toEqual({
      type: "identityPoliciesRead",
      requestId: 11,
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [storedBypass(22, 50)],
    });
    expect(readIdentityPolicies({ type: "readIdentityPolicies", requestId: 12, ids: [23] })).toEqual({
      type: "identityPoliciesRead",
      requestId: 12,
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [],
    });
  });

  test("多 ID 批量路径去重并同时叠加已提交行、未提交新增、覆盖与删除", () => {
    const updatedWhitelist: string = whitelistData("白2-批量覆盖");
    const insertedWhitelist: string = whitelistData("白4-批量新增");
    pendingWhitelistWrites.set(2, { data: updatedWhitelist, revision: 2 });
    pendingWhitelistWrites.set(3, { data: null, revision: 2 });
    pendingWhitelistWrites.set(4, { data: insertedWhitelist, revision: 1 });

    const updatedBlocklist: string = blocklistData("黑12-批量覆盖");
    const insertedBlocklist: string = blocklistData("黑14-批量新增");
    pendingBlocklistWrites.set(12, { data: updatedBlocklist, revision: 2 });
    pendingBlocklistWrites.set(13, { data: null, revision: 2 });
    pendingBlocklistWrites.set(14, { data: insertedBlocklist, revision: 1 });

    pendingTemporaryAdBypassWrites.set(22, { activity: bypassActivity(20), revision: 2 });
    pendingTemporaryAdBypassWrites.set(23, { activity: null, revision: 2 });
    pendingTemporaryAdBypassWrites.set(24, { activity: bypassActivity(30), revision: 1 });

    const reply: IdentityPoliciesReadReply = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 13,
      ids: [1, 1, 2, 3, 4, 11, 12, 13, 14, 21, 22, 23, 24, 999],
    });

    expect(reply.error).toBeUndefined();
    expect(new Map(reply.whitelist)).toEqual(new Map([
      [1, whitelistData("白1-已提交")],
      [2, updatedWhitelist],
      [4, insertedWhitelist],
    ]));
    expect(new Map(reply.blocklist)).toEqual(new Map([
      [11, blocklistData("黑11-已提交")],
      [12, updatedBlocklist],
      [14, insertedBlocklist],
    ]));
    expect(
      new Map(reply.temporaryAdBypass!.map((row: StoredTemporaryAdBypassActivity): [number, StoredTemporaryAdBypassActivity] => [row.id, row]))
    ).toEqual(new Map([
      [21, storedBypass(21, 1)],
      [22, storedBypass(22, 20)],
      [24, storedBypass(24, 30)],
    ]));
  });

  test("去重后 ID 数超过单批上限时以错误回执拒绝，不抛出异常", () => {
    const tooManyIds: number[] = Array.from(
      { length: IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1 },
      (_unused: unknown, index: number): number => index + 1
    );
    const reply: IdentityPoliciesReadReply = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 14,
      ids: tooManyIds,
    });
    expect(reply).toEqual({
      type: "identityPoliciesRead",
      requestId: 14,
      error: `Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`,
    });
  });
});
