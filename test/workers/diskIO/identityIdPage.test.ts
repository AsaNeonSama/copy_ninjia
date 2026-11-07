import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { storageDatabaseSchema } from
  "../../../packages/database/schema/storage";
import {
  pendingBlocklistWrites,
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
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
});
