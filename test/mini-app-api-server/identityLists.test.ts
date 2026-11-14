/**
 * Mini App 白名单与黑名单列表、搜索的读取与 Bot 合并身份缓存隔离：条目直接冷读并在请求内局部持有，
 * 不读写 `identityPolicyCache`；名单规模超过 LRU 容量时搜索仍覆盖全部条目，本地未 ACK 最终值覆盖数据库结果。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { MINI_APP_IDENTITY_MAX_PAGE_SIZE } from "../../packages/consts/miniApp";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import {
  installMiniAppTestDiskIOMock,
  miniAppTestBlocklistRows as blocklistRows,
  miniAppTestJoinLogState,
  miniAppTestWhitelistRows as whitelistRows,
  readIdentityIdPageMock,
  readIdentityPoliciesMock as readIdentityPolicies,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

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
  resetMiniAppTestDiskIOState();
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
    const page1 = await listWhitelistEntries({
      page: 1,
      pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    });
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
    const page2 = await listWhitelistEntries({
      page: 1,
      pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    });
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
    const page3 = await listWhitelistEntries({
      page: 1,
      pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    });
    const staleItem = page3.items.find((item) => item.id === staleEntryId);
    expect(staleItem?.displayName).toBe("StaleHolder");
    expect(staleItem?.username).toBeUndefined();
    expect(resolveUsernameTarget("reassigned_alias")?.id).toBe(newOwnerId);

    // 列表读取 flush 期间并发排入且尚未收到落盘 ACK 的内存新增条目立即叠加在游标页中
    const pendingId: number = 2004;
    await prefetchIdentityPolicies([pendingId]);
    miniAppTestJoinLogState.onFlushDiskIODomain = (): void => {
      miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
      queueIdentityPolicyWrite("whitelist", pendingId, {
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: { firstName: "PendingMember", lastName: "", username: "pending_user" },
      });
    };
    const page4 = await listWhitelistEntries({
      page: 1,
      pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE,
    });
    expect(page4.items.some((item) => item.id === pendingId)).toBeTrue();
  });

  test("名单搜索支持 @ 前缀、纯数字 ID 与仅命中用户名三种情形（忽略大小写）", async () => {
    whitelistRows.set(3001, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "AlphaDisplay", lastName: "", username: "secret_handle" },
    }));
    whitelistRows.set(3002, JSON.stringify({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "BetaDisplay", lastName: "", username: "" },
    }));
    blocklistRows.set(4001, JSON.stringify({
      blockedAt: "2026/10/27 00:00:00",
      meta: { firstName: "GammaDisplay", lastName: "", username: "raid_channel" },
    }));

    // 1. @ 前缀搜索：命中 username 或剥离 @ 后的 displayName
    const byAtUsername = await listWhitelistEntries({ query: "@SECRET_HANDLE" });
    expect(byAtUsername.items.map((item) => item.id)).toEqual([3001]);

    const byAtDisplayName = await listWhitelistEntries({ query: "@betadisplay" });
    expect(byAtDisplayName.items.map((item) => item.id)).toEqual([3002]);

    const blockByAtUsername = await listBlocklistEntries({ query: "@RAID_CHANNEL" });
    expect(blockByAtUsername.items.map((item) => item.id)).toEqual([4001]);

    // 2. 纯数字 ID 搜索：displayName 与 username 均不含该数字串时仍按 ID 命中
    const byPureId = await listWhitelistEntries({ query: "3002" });
    expect(byPureId.items.map((item) => item.id)).toEqual([3002]);

    const blockByPureId = await listBlocklistEntries({ query: "4001" });
    expect(blockByPureId.items.map((item) => item.id)).toEqual([4001]);

    // 3. 仅命中用户名（不带 @，且 displayName 不包含该子串）
    const byUsernameOnly = await listWhitelistEntries({ query: "secret_handle" });
    expect(byUsernameOnly.items.map((item) => item.id)).toEqual([3001]);

    const blockByUsernameOnly = await listBlocklistEntries({ query: "raid_channel" });
    expect(blockByUsernameOnly.items.map((item) => item.id)).toEqual([4001]);
  });

  test("按关键词搜索跨页补扫时，整页被未 ACK 删除清空且 done=false 仍继续扫下一页", async () => {
    const baseId: number = 90_000;
    const totalRows: number = BLOCKLIST_SWEEP_PAGE_SIZE * 2 + 1;
    const survivorId: number = baseId + totalRows;
    const pendingDeleteIds: number[] = [];
    for (let offset: number = 1; offset <= totalRows; offset++) {
      const id: number = baseId + offset;
      whitelistRows.set(id, JSON.stringify({
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: {
          firstName: offset < totalRows ? `SweepPending${offset}` : "SweepSurvivor",
          lastName: "",
          username: "",
        },
      }));
      if (offset < totalRows) pendingDeleteIds.push(id);
    }
    await prefetchIdentityPolicies(pendingDeleteIds);

    let flushIndex: number = 0;
    miniAppTestJoinLogState.onFlushDiskIODomain = (): void => {
      const pageStart: number = flushIndex * BLOCKLIST_SWEEP_PAGE_SIZE;
      const pageEnd: number = pageStart + BLOCKLIST_SWEEP_PAGE_SIZE;
      flushIndex += 1;
      for (const id of pendingDeleteIds.slice(pageStart, pageEnd)) {
        queueIdentityPolicyWrite("whitelist", id, null);
      }
      if (flushIndex >= 2) {
        miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
      }
    };
    readIdentityIdPageMock.mockClear();

    try {
      const searched = await listWhitelistEntries({
        query: "Sweep",
        page: 1,
        pageSize: MINI_APP_IDENTITY_MAX_PAGE_SIZE,
      });
      expect(searched.total).toBe(1);
      expect(searched.items.map((item) => item.id)).toEqual([survivorId]);
      const cursors: readonly (number | null)[] = readIdentityIdPageMock.mock.calls.map(
        (call): number | null => call[1]
      );
      expect(cursors).toEqual([
        null,
        baseId + BLOCKLIST_SWEEP_PAGE_SIZE,
        baseId + BLOCKLIST_SWEEP_PAGE_SIZE * 2,
      ]);
    } finally {
      miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
    }
  });
});
