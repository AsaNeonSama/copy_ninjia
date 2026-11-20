/**
 * 共享存储数据库身份策略读取接口（`packages/database/interact/identityPolicy.ts`）单元测试：
 * 覆盖空批次、单 ID 与多 ID 读取、批次上限拒绝、预编译主键存在性查询与升序分页游标。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../packages/consts/identityStorage";
import { TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD } from "../../packages/consts/temporaryAdBypass";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import {
  prepareStoredIdentityIdLookups,
  readStoredIdentityIdPage,
  readStoredIdentityPolicies,
  readStoredIdentityPolicy,
} from "../../packages/database/interact/identityPolicy";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { prepareStorageDatabaseReader } from "../../packages/database/interact/reader";
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../packages/database/interact/transaction";
import { storageDatabaseSchema } from "../../packages/database/schema/storage";
import type {
  StorageDatabase,
  StorageDatabaseReader,
  StoredIdentityIdLookups,
} from "../../packages/types/storageDatabase";

let temporaryRoot: string;
let client: Database;
let database: StorageDatabase;
let reader: StorageDatabaseReader;

const WHITE_10: string = encodeWhitelistEntryData({
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: { firstName: "白10", lastName: "", username: "w10" },
});
const WHITE_20: string = encodeWhitelistEntryData({
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: { firstName: "白20", lastName: "", username: "w20" },
});
const BLOCK_30: string = encodeBlocklistEntryData({
  meta: { firstName: "黑30", lastName: "", username: "b30" },
  blockedAt: "2026/01/01 00:00:00",
});
const BLOCK_40: string = encodeBlocklistEntryData({
  meta: { firstName: "黑40", lastName: "", username: "b40" },
  blockedAt: "2026/01/02 00:00:00",
});

beforeEach((): void => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-db-identity-policy-"));
  const dbPath: string = join(temporaryRoot, "storage.sqlite");
  createStorageDatabase(dbPath);
  client = new Database(dbPath, { strict: true });
  database = drizzle({ client, schema: storageDatabaseSchema });
  commitStorageDatabaseChanges(prepareStorageDatabaseWriter(database), {
    whitelist: new Map([
      [-100, { data: WHITE_10 }],
      [10, { data: WHITE_10 }],
      [20, { data: WHITE_20 }],
    ]),
    blocklist: new Map([
      [30, { data: BLOCK_30 }],
      [40, { data: BLOCK_40 }],
    ]),
    temporaryAdBypass: new Map([
      [50, {
        activity: {
          adBypass: true,
          adBypassGrantedAt: 1_000,
          qualifiedDays: 1,
          sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1,
          countedAt: 3_000,
          qualifiedAt: 2_000,
        },
        revision: 1,
      }],
    ]),
    removals: new Map(),
    chatStates: new Map(),
    chatQa: new Map(),
    aiContexts: new Map(),
  });
  reader = prepareStorageDatabaseReader(database);
});

afterEach((): void => {
  client.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("database/interact/identityPolicy", () => {
  test("readStoredIdentityPolicies 覆盖空列表、单 ID 命中/缺失与多 ID 批量查询", () => {
    expect(readStoredIdentityPolicies(reader, "whitelist", [])).toEqual([]);
    expect(readStoredIdentityPolicies(reader, "blocklist", [])).toEqual([]);

    expect(readStoredIdentityPolicies(reader, "whitelist", [10])).toEqual([{ id: 10, data: WHITE_10 }]);
    expect(readStoredIdentityPolicies(reader, "whitelist", [999])).toEqual([]);
    expect(readStoredIdentityPolicies(reader, "blocklist", [30])).toEqual([{ id: 30, data: BLOCK_30 }]);
    expect(readStoredIdentityPolicies(reader, "blocklist", [999])).toEqual([]);

    expect(readStoredIdentityPolicies(reader, "whitelist", [10, 999, 20])).toEqual([
      { id: 10, data: WHITE_10 },
      { id: 20, data: WHITE_20 },
    ]);
    expect(readStoredIdentityPolicies(reader, "blocklist", [30, 40, 999])).toEqual([
      { id: 30, data: BLOCK_30 },
      { id: 40, data: BLOCK_40 },
    ]);
  });

  test("readStoredIdentityPolicies 超过 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES 时直接抛错", () => {
    const oversizedIds: number[] = Array.from(
      { length: IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1 },
      (_unused: unknown, index: number): number => index + 1
    );
    expect((): void => {
      readStoredIdentityPolicies(reader, "whitelist", oversizedIds);
    }).toThrow(`Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`);
    expect((): void => {
      readStoredIdentityPolicies(reader, "blocklist", oversizedIds);
    }).toThrow(`Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`);
  });

  test("readStoredIdentityPolicy 与 prepareStoredIdentityIdLookups 精确区分存在与缺失主键", () => {
    expect(readStoredIdentityPolicy(reader, "whitelist", 20)).toEqual({ id: 20, data: WHITE_20 });
    expect(readStoredIdentityPolicy(reader, "whitelist", 30)).toBeUndefined();
    expect(readStoredIdentityPolicy(reader, "blocklist", 40)).toEqual({ id: 40, data: BLOCK_40 });
    expect(readStoredIdentityPolicy(reader, "blocklist", 10)).toBeUndefined();

    const lookups: StoredIdentityIdLookups = prepareStoredIdentityIdLookups(database);
    expect(lookups.whitelist.get({ id: -100 })).toEqual({ id: -100 });
    expect(lookups.whitelist.get({ id: 30 })).toBeUndefined();
    expect(lookups.blocklist.get({ id: 30 })).toEqual({ id: 30 });
    expect(lookups.blocklist.get({ id: 10 })).toBeUndefined();
    expect(lookups.temporaryAdBypass.get({ id: 50 })).toEqual({ id: 50 });
    expect(lookups.temporaryAdBypass.get({ id: 51 })).toBeUndefined();
  });

  test("readStoredIdentityIdPage 按主键升序游标与页大小分页读取", () => {
    expect(readStoredIdentityIdPage(database, "whitelist", { afterId: null, limit: 2 })).toEqual([-100, 10]);
    expect(readStoredIdentityIdPage(database, "whitelist", { afterId: 10, limit: 2 })).toEqual([20]);
    expect(readStoredIdentityIdPage(database, "whitelist", { afterId: 20, limit: 2 })).toEqual([]);
    expect(readStoredIdentityIdPage(database, "blocklist", { afterId: null, limit: 5 })).toEqual([30, 40]);
  });
});
