import {
  identityEntryCounts,
  resetIdentityStorageCache,
} from "../../packages/cache/main/identityStorage";

import type { BlocklistEntryData } from "../../packages/types/identityPolicy";
import { identityFieldView } from "./identityCacheView";
import type { IdentityFieldView } from "./identityCacheView";

const whitelistField: IdentityFieldView<"whitelist"> = identityFieldView("whitelist");
const blocklistField: IdentityFieldView<"blocklist"> = identityFieldView("blocklist");
const temporaryAdBypassField: IdentityFieldView<"temporaryAdBypass"> = identityFieldView("temporaryAdBypass");

interface BlockedTestRecord {
  readonly isBlocked: true;
  readonly blockedAt: string;
}

/** 本模块写入测试身份时附带的无敏感字段 meta。 */
const TEST_IDENTITY_META: Readonly<{
  firstName: string;
  lastName: string;
  username: string;
}> = { firstName: "Test", lastName: "", username: "test" };

const blockedIdentityTestIds: Set<number> = new Set<number>();

/**
 * 测试 isolate 内的黑名单 Map 观察适配器；生产代码不持有无界黑名单 Map。
 * set 同时补齐三张关系的正/负缓存，使被测写操作满足“先冷读、后变更”的前提。
 */
export const blockedIdentityTestView: {
  readonly size: number;
  clear(): void;
  get(id: number): BlockedTestRecord | undefined;
  has(id: number): boolean;
  keys(): IterableIterator<number>;
  set(id: number, record: BlockedTestRecord): void;
} = {
  get size(): number {
    return identityEntryCounts.blocklist;
  },
  clear(): void {
    blockedIdentityTestIds.clear();
    resetIdentityStorageCache();
  },
  get(id: number): BlockedTestRecord | undefined {
    const entry: Readonly<BlocklistEntryData> | null | undefined =
      blocklistField.peek(id);
    return entry === undefined || entry === null
      ? undefined
      : { isBlocked: true, blockedAt: entry.blockedAt };
  },
  has(id: number): boolean {
    return blocklistField.peek(id) !== undefined &&
      blocklistField.peek(id) !== null;
  },
  keys(): IterableIterator<number> {
    return blockedIdentityTestIds.keys();
  },
  set(id: number, record: BlockedTestRecord): void {
    if (!this.has(id)) identityEntryCounts.blocklist++;
    blockedIdentityTestIds.add(id);
    blocklistField.set(id, {
      blockedAt: record.blockedAt,
      meta: TEST_IDENTITY_META,
    });
    whitelistField.set(id, null);
    temporaryAdBypassField.set(id, null);
  },
};

/** 模拟 SQLite 全表主键查询；不受主线程 LRU 淘汰影响。 */
export function readBlockedIdentityTestIds(): readonly number[] {
  return [...blockedIdentityTestIds];
}

/** 为将要新增的身份建立三张关系的负缓存。 */
export function seedMissingIdentity(id: number): void {
  if (!blocklistField.has(id)) blocklistField.set(id, null);
  if (!whitelistField.has(id)) whitelistField.set(id, null);
  if (!temporaryAdBypassField.has(id)) {
    temporaryAdBypassField.set(id, null);
  }
}
