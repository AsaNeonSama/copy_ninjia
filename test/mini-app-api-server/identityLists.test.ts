/**
 * Mini App 白名单与黑名单列表、搜索的读取与 Bot 合并身份缓存隔离：条目直接冷读并在请求内局部持有，
 * 不读写 `identityPolicyCache`；名单规模超过 LRU 容量时搜索仍覆盖全部条目，本地未 ACK 最终值覆盖数据库结果。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { MINI_APP_IDENTITY_MAX_PAGE_SIZE } from "../../packages/consts/miniApp";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";

const whitelistRows: Map<number, string> = new Map<number, string>();
const blocklistRows: Map<number, string> = new Map<number, string>();

/** 按 SQLite 游标页契约从夹具行表切出 `afterId` 之后的一页主键。 */
function idPage(rows: ReadonlyMap<number, string>, afterId: number | null): BlocklistIdPage {
  const sorted: number[] = [...rows.keys()]
    .filter((id: number): boolean => afterId === null || id > afterId)
    .sort((left: number, right: number): number => left - right);
  const ids: number[] = sorted.slice(0, BLOCKLIST_SWEEP_PAGE_SIZE);
  return {
    ids,
    nextCursor: ids.length === 0 ? afterId : ids[ids.length - 1]!,
    done: sorted.length <= BLOCKLIST_SWEEP_PAGE_SIZE,
  };
}

const readIdentityPolicies = mock(
  async (ids: readonly number[]): Promise<IdentityPolicyRawReadResult> => {
    const whitelist: [number, string][] = [];
    const blocklist: [number, string][] = [];
    for (const id of ids) {
      const whitelistText: string | undefined = whitelistRows.get(id);
      if (whitelistText !== undefined) whitelist.push([id, whitelistText]);
      const blocklistText: string | undefined = blocklistRows.get(id);
      if (blocklistText !== undefined) blocklist.push([id, blocklistText]);
    }
    return { whitelist, blocklist, temporaryAdBypass: [] };
  }
);

let onFlushDiskIODomain: (() => void) | undefined;

mock.module("../../packages/infra/diskIO", () =>
  diskIOStub({
    isDiskIOInitialized: (): boolean => true,
    flushDiskIODomain: async () => {
      onFlushDiskIODomain?.();
      return { result: "flushed" as const };
    },
    onDiskIOReply: diskIOReplyStub({}),
    postDiskIO: (): boolean => true,
    readIdentityPolicies,
    readWhitelistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> =>
      idPage(whitelistRows, afterId),
    readBlocklistIdPage: async (afterId: number | null): Promise<BlocklistIdPage> =>
      idPage(blocklistRows, afterId),
    relayLogMessage: (): boolean => true,
  })
);

const { identityPolicyCache, resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const {
  identityById,
  senderUsernameCache,
  userCache,
} = await import("../../packages/cache/main/senderIdentity");
const {
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  readIdentityPolicyEntries,
} = await import("../../packages/infra/identityStorage");
const {
  resolveIdTarget,
  resolveUsernameTarget,
  updateCachedIdentity,
} = await import("../../packages/users/senderIdentity");
const { listWhitelistEntries } = await import(
  "../../packages/mini-app-api-server/view/identities/whitelist"
);
const { listBlocklistEntries } = await import(
  "../../packages/mini-app-api-server/view/identities/blocklist"
);

/** 白名单夹具首个 ID；黑名单夹具紧随其后，两表互斥。 */
const WHITELIST_BASE_ID: number = 1_000_000;

/** 写入 `count` 条可被关键字 `member` 命中的白名单与黑名单夹具。 */
function seedLists(count: number): void {
  for (let offset: number = 0; offset < count; offset++) {
    whitelistRows.set(WHITELIST_BASE_ID + offset, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: `member${offset}`, lastName: "", username: "" },
    }));
    blocklistRows.set(WHITELIST_BASE_ID + count + offset, JSON.stringify({
      blockedAt: "2026/10/27 00:00:00",
      meta: { firstName: `member${offset}`, lastName: "", username: "" },
    }));
  }
}

beforeEach((): void => {
  onFlushDiskIODomain = undefined;
  whitelistRows.clear();
  blocklistRows.clear();
  readIdentityPolicies.mockClear();
  resetIdentityStorageCache();
  userCache.clear();
  senderUsernameCache.clear();
  identityById.clear();
});

describe("Mini App 名单读取与 Bot 合并身份缓存隔离", () => {
  test("名单规模超过身份 LRU 容量时搜索仍返回全部匹配，列表与搜索都不读写 Bot 缓存", async () => {
    const count: number = IDENTITY_READ_CACHE_MAX_ENTRIES + BLOCKLIST_SWEEP_PAGE_SIZE;
    seedLists(count);
    const hotSenderId: number = 7;
    await prefetchIdentityPolicies([hotSenderId]);
    const cachedBefore: number = identityPolicyCache.size;

    const whitelistSearch = await listWhitelistEntries({ query: "member", pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE });
    const blocklistSearch = await listBlocklistEntries({ query: "member", pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE });
    const whitelistPage = await listWhitelistEntries({ page: 2, pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE });
    const blocklistPage = await listBlocklistEntries({ page: 2, pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE });

    expect(whitelistSearch.total).toBe(count);
    expect(blocklistSearch.total).toBe(count);
    expect(whitelistPage.items).toHaveLength(MINI_APP_IDENTITY_MAX_PAGE_SIZE);
    expect(whitelistPage.items[0]?.id).toBe(WHITELIST_BASE_ID + MINI_APP_IDENTITY_MAX_PAGE_SIZE);
    expect(blocklistPage.items).toHaveLength(MINI_APP_IDENTITY_MAX_PAGE_SIZE);
    expect(identityPolicyCache.size).toBe(cachedBefore);
    expect(identityPolicyCache.peek(hotSenderId)).toBeDefined();
    expect(identityPolicyCache.peek(WHITELIST_BASE_ID)).toBeUndefined();
  });

  test("直接冷读按预取分块上限分块，本地未 ACK 最终值覆盖数据库结果且不新增缓存条目", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1; id++) ids.push(id);
    await readIdentityPolicyEntries(ids);
    expect(readIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(readIdentityPolicies.mock.calls[0]![0]).toHaveLength(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(identityPolicyCache.size).toBe(0);

    const removedId: number = 11;
    const addedId: number = 12;
    whitelistRows.set(removedId, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Removed", lastName: "", username: "" },
    }));
    await prefetchIdentityPolicies([removedId, addedId]);
    queueIdentityPolicyWrite("whitelist", removedId, null);
    queueIdentityPolicyWrite("blocklist", addedId, {
      blockedAt: "2026/10/27 00:00:00",
      meta: { firstName: "Added", lastName: "", username: "" },
    });
    const cachedBefore: number = identityPolicyCache.size;

    const entries = await readIdentityPolicyEntries([removedId, addedId, addedId]);
    expect(entries.whitelist.has(removedId)).toBeFalse();
    expect(entries.blocklist.get(addedId)?.meta.firstName).toBe("Added");
    expect(readIdentityPolicies.mock.calls.at(-1)![0]).toEqual([removedId, addedId]);
    expect(identityPolicyCache.size).toBe(cachedBefore);
  });

  test("Mini App 名单查询与 Bot 发送者缓存及未 ACK 增删写叠加双向同步，且不以旧用户名覆盖新持有人", async () => {
    const syncId: number = 2001;
    whitelistRows.set(syncId, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "DbName", lastName: "", username: "db_user" },
    }));
    const page1 = await listWhitelistEntries({ page: 1, pageSize: 20 });
    expect(page1.items[0]?.displayName).toBe("DbName");
    expect(page1.items[0]?.username).toBe("db_user");
    // DB 带非空 username 的条目回填至 Bot 的 senderIdentity 缓存
    expect(resolveIdTarget(syncId)).toEqual({
      id: syncId,
      username: "db_user",
      first_name: "DbName",
      last_name: undefined,
    });

    // Bot 侧收到新消息更新昵称与用户名后，API Server 列表读取自动同步最新值
    updateCachedIdentity({
      id: syncId,
      username: "live_bot_user",
      first_name: "LiveBotName",
      last_name: "Chan",
    });
    const page2 = await listWhitelistEntries({ page: 1, pageSize: 20 });
    expect(page2.items[0]?.displayName).toBe("LiveBotName Chan");
    expect(page2.items[0]?.username).toBe("live_bot_user");

    // 若另一身份已接管旧用户名，读取 DB 中的旧条目不会冲掉新持有人的 username 缓存
    const newOwnerId: number = 2002;
    const staleEntryId: number = 2003;
    updateCachedIdentity({
      id: newOwnerId,
      username: "reassigned_alias",
      first_name: "NewOwner",
      last_name: undefined,
    });
    whitelistRows.set(staleEntryId, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "StaleHolder", lastName: "", username: "reassigned_alias" },
    }));
    const page3 = await listWhitelistEntries({ page: 1, pageSize: 20 });
    const staleItem = page3.items.find((item) => item.id === staleEntryId);
    expect(staleItem?.displayName).toBe("StaleHolder");
    expect(staleItem?.username).toBeUndefined();
    expect(resolveUsernameTarget("reassigned_alias")?.id).toBe(newOwnerId);

    // 列表读取 flush 期间并发排入且尚未收到落盘 ACK 的内存新增条目立即叠加在游标页中
    const pendingId: number = 2004;
    await prefetchIdentityPolicies([pendingId]);
    onFlushDiskIODomain = (): void => {
      onFlushDiskIODomain = undefined;
      queueIdentityPolicyWrite("whitelist", pendingId, {
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: { firstName: "PendingMember", lastName: "", username: "pending_user" },
      });
    };
    const page4 = await listWhitelistEntries({ page: 1, pageSize: 20 });
    expect(page4.items.some((item) => item.id === pendingId)).toBeTrue();
  });
});
