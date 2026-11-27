import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../packages/consts/identityStorage";
import {
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
} from "../../../packages/database/codec/identity";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import {
  pendingWhitelistWrites,
  pendingBlocklistWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
  rejectedStorageDomains,
  pendingChatQaWrites,
  storagePersistenceReplyHolder,
  storageWriteFlushTimer,
  storageWriteRetry,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { diskIOOperationTail } from
  "../../../packages/cache/workers/diskIO/recovery";
import {
  flushStorageDatabase,
  collectStorageDatabaseFailures,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import {
  hydrateStorageDatabase,
  resetDatabaseFixture,
  whitelistWrite,
} from "../../helpers/storageDatabaseHydration";
import {
  handleIdentityPolicyWrite,
  hasAnyEffectiveBlocklistIdentity,
} from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { handleBlocklistRemovalWrite } from
  "../../../packages/workers/diskIO/storageDatabase/pendingRemoval";
import type {
  DiskIODomain,
  IdentityPolicyWriteDiskMessage,
  IdentityStoragePersistedReply,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";

const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

beforeEach((): void => {
  acknowledgements.length = 0;
  storagePersistenceReplyHolder.current = null;
  resetDatabaseFixture();
});

afterEach((): void => {
  resetStorageDatabaseCache();
  storagePersistenceReplyHolder.current = null;
  jest.useRealTimers();
});

describe("DiskIO Worker SQLite 定时提交与失败重试", (): void => {
  test("首条 dirty 只建一个 unref timer，ACK 通道恢复后原批只提交一次", async (): Promise<void> => {
    jest.useFakeTimers();

    handleIdentityPolicyWrite(whitelistWrite(7, 1), reply);
    const firstTimer: ReturnType<typeof setTimeout> | null =
      storageWriteFlushTimer.current;
    expect(firstTimer).not.toBeNull();
    expect(firstTimer?.hasRef()).toBeFalse();

    handleIdentityPolicyWrite(whitelistWrite(8, 1), reply);
    expect(storageWriteFlushTimer.current).toBe(firstTimer);

    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);
    await diskIOOperationTail.current;
    const retryTimer: ReturnType<typeof setTimeout> | null =
      storageWriteFlushTimer.current;
    expect(retryTimer).not.toBeNull();
    expect(retryTimer).not.toBe(firstTimer);
    expect(retryTimer?.hasRef()).toBeFalse();
    expect(pendingWhitelistWrites).toHaveLength(2);
    expect(acknowledgements).toHaveLength(0);

    storagePersistenceReplyHolder.current = reply;
    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);
    await diskIOOperationTail.current;

    expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [
        { table: "whitelist", id: 7, revision: 1 },
        { table: "whitelist", id: 8, revision: 1 },
      ],
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      adPackBlacklistWrites: [],
      removalWrites: [],
    }]);
  });

  test("真实 SQLite 事务失败保留最终值并重排，连接恢复后再 durable ACK", (): void => {
    handleIdentityPolicyWrite(whitelistWrite(9, 4), reply);
    const failedDatabase: StorageDatabase | null = storageDatabaseHandle.current;
    expect(failedDatabase).not.toBeNull();
    closeStorageDatabase(failedDatabase!);

    expect(flushStorageDatabase(reply)).toBeFalse();
    expect(pendingWhitelistWrites.get(9)?.revision).toBe(4);
    expect(storageWriteFlushTimer.current).not.toBeNull();
    expect(acknowledgements).toHaveLength(0);

    storageDatabaseHandle.current = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [{ table: "whitelist", id: 9, revision: 4 }],
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      adPackBlacklistWrites: [],
      removalWrites: [],
    }]);

    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().permissionEntryCount).toBe(1);
  });

  test("节拍到点时提交仍然失败：点名记一行并重排下一拍，不丢最终值", async (): Promise<void> => {
    // 提交失败时重排下一拍：定时器已自清，dirty 标记保留，最终值留在内存等下一拍。
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      handleIdentityPolicyWrite(whitelistWrite(11, 6), reply);
      storagePersistenceReplyHolder.current = reply;
      closeStorageDatabase(storageDatabaseHandle.current!);

      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);
      await diskIOOperationTail.current;

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[diskIOWorker] storage database transaction failed:", expect.any(Error));
      expect(storageWriteFlushTimer.current).not.toBeNull();
      expect(pendingWhitelistWrites.get(11)?.revision).toBe(6);
      expect(acknowledgements).toHaveLength(0);
    } finally {
      error.mockRestore();
      // 句柄已经被关掉，afterEach 的 reset 不能再去关第二次。
      storageDatabaseHandle.current = null;
    }
  });

  test("失败领域取走即清空：拒收标记与本轮仍 dirty 的表合并上报一次", (): void => {
    // 取走即清空拒收标记，该领域此后的 flush 不再回报失败。
    rejectedStorageDomains.add("blocklistRemovalOutbox");
    handleIdentityPolicyWrite(whitelistWrite(12, 7), reply);
    pendingChatQaWrites.set(-1001, new Map([["问", { answer: "答", revision: 1 }]]) as never);

    const first: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, first);
    expect(new Set(first)).toEqual(new Set(["blocklistRemovalOutbox", "whitelist", "chatQa"]));

    // 取走一次之后拒收标记不再复现；仍 dirty 的表照旧上报。
    const second: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, second);
    expect(new Set(second)).toEqual(new Set(["whitelist", "chatQa"]));
  });

  test("单领域屏障只取走本领域的拒收标记，别的领域留给它自己的屏障回报", (): void => {
    rejectedStorageDomains.add("chatState");
    rejectedStorageDomains.add("whitelist");
    handleIdentityPolicyWrite(whitelistWrite(13, 8), reply);

    expect(flushStorageDatabase(reply)).toBeTrue();
    const whitelistBarrier: DiskIODomain[] = [];
    collectStorageDatabaseFailures("whitelist", whitelistBarrier);
    expect(whitelistBarrier).toEqual(["whitelist"]);

    // whitelist 屏障不带走 chatState 的拒收，该失败由 chatState 屏障回报。
    const chatStateBarrier: DiskIODomain[] = [];
    collectStorageDatabaseFailures("chatState", chatStateBarrier);
    expect(chatStateBarrier).toEqual(["chatState"]);
    const again: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, again);
    expect(again).toEqual([]);
  });

  test("事务提交成功而另有拒收标记时，提交结果仍报成功，定时节拍不记失败", async (): Promise<void> => {
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      rejectedStorageDomains.add("chatQa");
      handleIdentityPolicyWrite(whitelistWrite(14, 9), reply);
      storagePersistenceReplyHolder.current = reply;

      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);
      await diskIOOperationTail.current;

      expect(pendingWhitelistWrites).toHaveLength(0);
      expect(error).not.toHaveBeenCalled();
      const failedDomains: DiskIODomain[] = [];
      collectStorageDatabaseFailures(null, failedDomains);
      expect(failedDomains).toEqual(["chatQa"]);
    } finally {
      error.mockRestore();
    }
  });

  test("删除一行从未落库的待踢任务同样进入事务并精确 ACK，后续 flush 不重复确认", (): void => {
    handleBlocklistRemovalWrite({
      type: "blocklistRemovalWrite",
      removalId: 5,
      data: null,
      revision: 5,
    }, reply);
    expect(acknowledgements).toEqual([]);

    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [],
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      adPackBlacklistWrites: [],
      removalWrites: [{ removalId: 5, revision: 5 }],
    }]);

    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements).toHaveLength(1);
  });

  function blocklistWrite(id: number, revision: number, deleted: boolean = false): IdentityPolicyWriteDiskMessage {
    return {
      type: "identityPolicyWrite",
      table: "blocklist",
      id,
      data: deleted
        ? null
        : encodeBlocklistEntryData({
          blockedAt: "2026/08/11 00:00:00",
          meta: { firstName: "Blocked", lastName: "", username: "" },
        }),
      revision,
    };
  }

  test("待写黑名单变更超过分页增量上限时，判空与退避期删除校验仍正常计算不抛错", (): void => {
    const count: number = BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES + 5;
    // 先写入一批已提交的黑名单行并提交进 SQLite。
    storagePersistenceReplyHolder.current = reply;
    for (let id: number = 1; id <= count + 1; id++) {
      handleIdentityPolicyWrite(blocklistWrite(id, 1), reply);
    }
    expect(flushStorageDatabase(reply)).toBeTrue();

    // 进入退避期：待写删除超过 BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES 时判空与删除校验不得因分页保护抛错。
    storageWriteRetry.failures = 1;
    storageWriteRetry.retryAt = performance.now() + IDENTITY_WRITE_FLUSH_INTERVAL_MS;
    for (let id: number = 1; id <= count; id++) {
      handleIdentityPolicyWrite(blocklistWrite(id, 2, true), reply);
    }
    expect(pendingBlocklistWrites.size).toBe(count);
    // 仍留有 1 条未删除的已提交黑名单身份 (count + 1)。
    expect(hasAnyEffectiveBlocklistIdentity()).toBeTrue();

    handleBlocklistRemovalWrite({
      type: "blocklistRemovalWrite",
      removalId: 10,
      data: encodePendingBlockedRemovalData(
        {
          params: { chatId: -1001, probeMembership: true, removalId: 10 },
          createdAt: 1,
          attempts: 0,
          lastFailure: null,
        },
        "storageDatabaseFlush.test"
      ),
      revision: 1,
    }, reply);
    // 再删掉最后一个有效黑名单身份（count + 1）必须触发业务级引用保护错（而非分页增量超限错）。
    expect(() => handleIdentityPolicyWrite(blocklistWrite(count + 1, 2, true), reply)).toThrow(
      "would leave pending sweep rows without any blocklist entry"
    );

    // 移除探活行后删净全部有效身份：hasAnyEffectiveBlocklistIdentity 应返回 false。
    handleBlocklistRemovalWrite({ type: "blocklistRemovalWrite", removalId: 10, data: null, revision: 2 }, reply);
    handleIdentityPolicyWrite(blocklistWrite(count + 1, 2, true), reply);
    expect(hasAnyEffectiveBlocklistIdentity()).toBeFalse();
  });
});
