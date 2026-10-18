/**
 * 连接级预编译读语句：结果与按 id 列表现拼的 `inArray` 查询逐行一致，
 * 同一连接上整套语句只 prepare 一次。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { storageDatabaseHandle } from "../../packages/cache/workers/diskIO/storageDatabase";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../packages/consts/identityStorage";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import { readStoredChatStateIds } from "../../packages/database/interact/chatState";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { readStoredIdentityPolicies } from "../../packages/database/interact/identityPolicy";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import { prepareStorageDatabaseReader } from "../../packages/database/interact/reader";
import { readStoredTemporaryAdBypassActivities } from "../../packages/database/interact/temporaryAdBypass";
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../packages/database/interact/transaction";
import { chatStates } from "../../packages/database/schema/chatState";
import { blocklistEntries, permissionList } from "../../packages/database/schema/identityPolicy";
import { jsonbTextProjection } from "../../packages/database/schema/jsonb";
import { temporaryAdBypassEntries } from "../../packages/database/schema/temporaryAdBypass";
import { requireStorageDatabaseReader } from "../../packages/workers/diskIO/storageDatabase/context";
import { chatStateOf } from "../helpers/chatState";
import type { StorageDatabase, StorageDatabaseChange, StorageDatabaseReader } from
  "../../packages/types/storageDatabase";
import type { StoredTemporaryAdBypassActivity } from "../../packages/types/temporaryAdBypass";

/** 正负、大小量级都覆盖：用户 id、频道马甲 id 与接近安全整数的极值。 */
const WHITELIST_IDS: readonly number[] = [1, 7, 42, 777_000_001, -1_001_234_567_890, 9_007_199_254_740_000];
const BLOCKLIST_IDS: readonly number[] = [2, 11, 12, 888_000_002, -1_009_876_543_210];
const BYPASS_IDS: readonly number[] = [3, 21, 22, 999_000_003];
const CHAT_IDS: readonly number[] = [-1_001, -1_002, -1_003];
const ABSENT_IDS: readonly number[] = [5, 6, -77, 123_456_789];

let temporaryRoot: string;
let database: StorageDatabase;

function bypassActivity(id: number): StoredTemporaryAdBypassActivity {
  return {
    id, adBypass: true, adBypassGrantedAt: 1_000,
    qualifiedDays: 1, sendCount: 8 + (id % 5), countedAt: 3_000, qualifiedAt: 2_000,
  };
}

function policyChanges(
  ids: readonly number[],
  encode: (id: number) => string
): ReadonlyMap<number, StorageDatabaseChange> {
  return new Map(ids.map((id: number): [number, StorageDatabaseChange] => [id, { data: encode(id) }]));
}

beforeEach((): void => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-reader-"));
  const path: string = join(temporaryRoot, "storage.sqlite");
  createStorageDatabase(path);
  database = openStorageDatabase({ path });
  commitStorageDatabaseChanges(prepareStorageDatabaseWriter(database), {
    whitelist: policyChanges(WHITELIST_IDS, (id: number): string => encodeWhitelistEntryData({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: `白${id}`, lastName: "", username: `w${Math.abs(id)}` },
    })),
    blocklist: policyChanges(BLOCKLIST_IDS, (id: number): string => encodeBlocklistEntryData({
      meta: { firstName: `黑${id}`, lastName: "", username: `b${Math.abs(id)}` },
      blockedAt: "2026/01/01 00:00:00",
    })),
    temporaryAdBypass: new Map(BYPASS_IDS.map((id: number) => [id, { activity: bypassActivity(id), revision: 1 }])),
    removals: new Map(),
    chatStates: new Map(CHAT_IDS.map((chatId: number): [number, StorageDatabaseChange] =>
      [chatId, { data: encodeChatStateData(chatStateOf({ isAIChatEnabled: true })) }])),
    chatQa: new Map(),
    aiContexts: new Map(),
  });
});

afterEach((): void => {
  storageDatabaseHandle.current = null;
  closeStorageDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

/** 被测 id 批次：命中、缺失、重复、乱序与混合。 */
function idBatches(stored: readonly number[]): readonly (readonly number[])[] {
  return [
    stored,
    [...stored].reverse(),
    ABSENT_IDS,
    [stored[0]!, stored[0]!, ...ABSENT_IDS, ...stored],
    [stored[stored.length - 1]!],
  ];
}

describe("database/interact/reader 预编译读语句", () => {
  test("名单批量读取与 inArray 现拼查询逐行一致", () => {
    const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
    for (const ids of idBatches(WHITELIST_IDS)) {
      expect(readStoredIdentityPolicies(reader, "whitelist", ids)).toEqual(database
        .select({ id: permissionList.id, data: jsonbTextProjection(permissionList.data) })
        .from(permissionList).where(inArray(permissionList.id, [...ids])).all());
    }
    for (const ids of idBatches(BLOCKLIST_IDS)) {
      expect(readStoredIdentityPolicies(reader, "blocklist", ids)).toEqual(database
        .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
        .from(blocklistEntries).where(inArray(blocklistEntries.id, [...ids])).all());
    }
  });

  test("临时免检批量读取与 inArray 现拼查询逐行一致", () => {
    const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
    for (const ids of idBatches(BYPASS_IDS)) {
      expect(readStoredTemporaryAdBypassActivities(reader, ids)).toEqual(database.select()
        .from(temporaryAdBypassEntries).where(inArray(temporaryAdBypassEntries.id, [...ids])).all());
    }
  });

  test("满批次上限的 id 列表照常读取", () => {
    const reader: StorageDatabaseReader = prepareStorageDatabaseReader(database);
    const ids: number[] = Array.from(
      { length: IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES },
      (_unused: unknown, index: number): number => index + 1
    );
    expect(readStoredIdentityPolicies(reader, "whitelist", ids).map((row: { id: number }): number => row.id))
      .toEqual(WHITELIST_IDS.filter((id: number): boolean => id >= 1 && id <= ids.length));
  });

  test("群状态主键读取与整表查询一致", () => {
    expect(readStoredChatStateIds(prepareStorageDatabaseReader(database)))
      .toEqual(database.select({ chatId: chatStates.chatId }).from(chatStates).all());
  });

  test("Worker 连接上整套读语句只 prepare 一次，之后每次读取复用", () => {
    storageDatabaseHandle.current = database;
    const prepare = spyOn(database.$client, "prepare");
    try {
      const first: StorageDatabaseReader = requireStorageDatabaseReader();
      const preparedCount: number = prepare.mock.calls.length;
      expect(preparedCount).toBeGreaterThan(0);
      for (let round: number = 0; round < 3; round++) {
        expect(requireStorageDatabaseReader()).toBe(first);
        readStoredIdentityPolicies(first, "whitelist", WHITELIST_IDS);
        readStoredIdentityPolicies(first, "blocklist", BLOCKLIST_IDS);
        readStoredTemporaryAdBypassActivities(first, BYPASS_IDS);
        readStoredChatStateIds(first);
      }
      expect(prepare.mock.calls.length).toBe(preparedCount);
    } finally {
      prepare.mockRestore();
    }
  });
});
