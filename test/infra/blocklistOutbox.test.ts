/**
 * 黑名单 outbox owner 的丢弃与销账分支。
 *
 * 这些路径都会去掉已经登记的待踢任务并逐行发出删除写入：启动恢复时群不再受管、
 * 机器人不再是管理员、补扫名单已空；运行期 /block disable 摘掉最后一个目标、群被停止管理。
 * 另含 write-ahead 补投（含只改了内存的诊断）、精确 ACK 与 Disk I/O 重建后的未 ACK 行重放。
 */

import { describe, expect, spyOn, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";
import type {
  DiskIORecoveryTransport,
  DiskIORespawnListener,
} from "../../packages/types/diskIO/messages";
const {
  blockedUserIds,
  installBlocklistSweepHooks,
  persistedListeners,
  postDiskIO,
  respawnListeners,
  states,
} = await import("../helpers/blocklistSweepHarness");

const {
  forgetChatBlocklistWork,
  forgetUserBlocklistRemovals,
  hydrateBlocklist,
  persistPendingBlockedRemovals,
  queueBlocklistRemovalWrite,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} = await import("../../packages/infra/blocklist/outbox");

const { unacknowledgedRemovalWrites } =
  await import("../../packages/cache/main/identityStorage");

const {
  quiesceBlocklistSweepScheduler,
  settleBlockedRemoval,
} = await import("../../packages/infra/blocklist/sweep");

const { updatePendingRemovalFailure } =
  await import("../../packages/infra/blocklist/sweepRetryState");

const {
  blocklistRemovalCounter,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
  unwrittenRemovalDiagnostics,
} = await import("../../packages/cache/main/blocklist");

const { logger } = await import("../../packages/infra/logger");

installBlocklistSweepHooks({
  quiesceBlocklistSweepScheduler,
  registerBlockedMemberRemover,
  settleBlockedRemoval,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
});

/** 受管且机器人是管理员——恢复保留任务的前提。 */
function governedChat(chatId: number = -1001): void {
  states.set(chatId, { isInitEnabled: true, botPermissions: botPermissions() });
}

/** 一条补扫任务（不带名单，投递时按当前黑名单现算）。 */
function sweepTask(
  removalId: number,
  overrides: Record<string, unknown> = {}
): [number, never] {
  return [removalId, {
    params: { chatId: -1001, probeMembership: true, removalId },
    createdAt: 1_000,
    attempts: 2,
    lastFailure: null,
    ...overrides,
  } as never];
}

/** 一条冻结名单的处置任务。 */
function frozenTask(
  removalId: number,
  userIds: readonly number[] = [7]
): [number, never] {
  return [removalId, {
    params: { chatId: -1001, probeMembership: false, removalId, userIds: [...userIds] },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  } as never];
}

describe("黑名单 outbox 的启动恢复过滤", () => {
  test("群已不再受管：任务被丢弃并发出该行的删除，编号水位仍前进", () => {
    // 编号水位跟着被丢弃的那条走：重启后新任务不复用旧编号（Worker 端的回执按编号匹配）。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    states.set(-1001, { isInitEnabled: false, botPermissions: botPermissions() });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistRemovalCounter.current).toBe(21);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(postDiskIO.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "blocklistRemovalWrite", removalId: 21, data: null })
    );
  });

  test("机器人已不是管理员：任务同样被丢弃", () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: { isAdministrator: false } });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
  });

  test("群状态整个读不到：按未受管处理，不留任务", () => {
    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("补扫任务的名单已空：销账，不留一条永远踢不到人的补扫", () => {
    // 补扫不带名单，投递时才按当前黑名单现算；名单空了它就没有目标了。
    governedChat();

    hydrateBlocklist(new Map([sweepTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("补扫任务名单非空且上次不是缺权限：重建未闩锁的补扫节奏", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([sweepTask(21)]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: 21,
      sweptAt: null,
      nextRetryAt: 1_000,
      resweepRequested: false,
      failedSweeps: 2,
      permissionBlocked: false,
    });
    // 一条都没被过滤掉，不多写一次快照。
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("同群既有缺权限闩锁又有普通补扫：闩锁不被后来的普通任务覆盖", () => {
    // 闩锁是「确证过没有封禁权限」，普通补扫只是「还没轮到」；后者不覆盖前者。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([
      sweepTask(21, { lastFailure: "missing-permission" }),
      sweepTask(22),
    ]));

    expect(blocklistSweepState.get(-1001)).toEqual(
      expect.objectContaining({ permissionBlocked: true })
    );
    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(pendingBlockedRemovals.has(22)).toBeTrue();
  });

  test("过滤后的删除行投不出去：点名记一行错误，不静默", () => {
    // 投不出去时落盘侧仍留着那条已经被主线程丢弃的任务，两边不一致，记一行日志。
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    postDiskIO.mockImplementation((): boolean => false);

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(error).toHaveBeenCalledWith(
      "Failed to queue the filtered blocklist removal outbox after startup recovery."
    );
    error.mockRestore();
  });

  test("没有任何任务被过滤时不发写入", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("冻结名单任务上次因缺权限失败：恢复出的补扫同样是闩锁态", () => {
    // 闩锁只跟「上次为什么失败」有关，与任务带不带冻结名单无关；冻结名单那一支同样保留闩锁。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([[21, {
      params: { chatId: -1001, probeMembership: false, removalId: 21, userIds: [7] },
      createdAt: 1_000,
      attempts: 3,
      lastFailure: "missing-permission",
    } as never]]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: null,
      sweptAt: null,
      nextRetryAt: 1_000,
      resweepRequested: false,
      failedSweeps: 3,
      permissionBlocked: true,
    });
  });

  test("恢复先清空既有镜像：上一轮的任务与补扫状态不残留", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21)]));
    expect(pendingBlockedRemovals.size).toBe(1);

    hydrateBlocklist(new Map());

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
    expect(blocklistSweepPages.size).toBe(0);
    expect(blocklistRemovalCounter.current).toBe(0);
  });
});

describe("黑名单 outbox 的运行期销账", () => {
  test("最后一个目标被 /block disable 摘掉：整条任务销账并释放 sweep claim", () => {
    // 不留空名单任务。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    blocklistSweepPages.set(21, {} as never);
    postDiskIO.mockClear();

    forgetUserBlocklistRemovals(7);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    expect(blocklistSweepPages.has(21)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("权威名单被清空：连补扫任务一起销账", () => {
    // 补扫不冻结名单，只有名单整体空了才销账；名单还有人时不动它，解封一个人不取消针对其他人的补扫。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([sweepTask(21)]));
    postDiskIO.mockClear();

    forgetUserBlocklistRemovals(7);
    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();

    blockedUserIds.clear();
    forgetUserBlocklistRemovals(8);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("销账后的行写入投不出去：点名被解封的那个 id", () => {
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    postDiskIO.mockImplementation((): boolean => false);

    forgetUserBlocklistRemovals(7);

    expect(error).toHaveBeenCalledWith(
      "Failed to queue blocklist removal outbox cleanup for unblocked user 7."
    );
    error.mockRestore();
  });

  test("群停止管理：该群全部任务与补扫进度一起删掉", () => {
    governedChat();
    governedChat(-1002);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([
      frozenTask(21, [7]),
      [22, {
        params: { chatId: -1002, probeMembership: false, removalId: 22, userIds: [7] },
        createdAt: 1_000,
        attempts: 0,
      } as never],
    ]));
    postDiskIO.mockClear();

    forgetChatBlocklistWork(-1001);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    // 另一个群的任务不受牵连。
    expect(pendingBlockedRemovals.has(22)).toBeTrue();
    expect(blocklistSweepState.has(-1001)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("群停止管理后的行写入投不出去：点名那个群", () => {
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    postDiskIO.mockImplementation((): boolean => false);

    forgetChatBlocklistWork(-1001);

    expect(error).toHaveBeenCalledWith(
      "Failed to queue blocklist removal outbox cleanup for unmanaged chat -1001."
    );
    error.mockRestore();
  });

  test("登记一条没有任何目标的处置：立刻抛错，且不把它留在镜像里", () => {
    // 不留下永远投不出去、占着 outbox 容量的任务。
    governedChat();

    expect(() => trackBlockedRemoval({
      chatId: -1001,
      probeMembership: true,
    } as never)).toThrow("Blocklist removal has no target to enforce.");
    expect(pendingBlockedRemovals.size).toBe(0);
  });
});

describe("黑名单 outbox 的投递边界", () => {
  test("新登记的行当场发出；投递被拒的行在 write-ahead 时按原 revision 补投，补投仍被拒就抛错", async () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    postDiskIO.mockImplementation((): boolean => false);
    const tracked = trackBlockedRemoval({ chatId: -1001, probeMembership: false, userIds: [7] } as never);
    const write = unacknowledgedRemovalWrites.get(tracked.removalId)!;
    const revision: number = write.revision;
    expect(write.bytes).toBeGreaterThan(0);
    expect(unacknowledgedRemovalWrites.get(tracked.removalId)).toEqual({
      revision,
      posted: false,
      bytes: write.bytes,
    });

    // write-ahead：补投仍被拒时抛错，处置不先于落盘发出。
    await expect(persistPendingBlockedRemovals()).rejects.toThrow(
      "Persistence Worker rejected a blocklist removal outbox write."
    );

    postDiskIO.mockClear();
    postDiskIO.mockImplementation((): boolean => true);
    await expect(persistPendingBlockedRemovals()).resolves.toBeUndefined();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(postDiskIO.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      type: "blocklistRemovalWrite",
      removalId: tracked.removalId,
      revision,
    }));
    expect(unacknowledgedRemovalWrites.get(tracked.removalId)).toEqual({
      revision,
      posted: true,
      bytes: write.bytes,
    });

    // 都已投出时 write-ahead 只等 flush，不重复投递。
    postDiskIO.mockClear();
    await persistPendingBlockedRemovals();
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("未确认字节超过存储写预算时拒绝排队，并回滚新登记的镜像行", async () => {
    const { STORAGE_PENDING_MAX_BYTES } = await import("../../packages/consts/diskIO/business");
    const { unacknowledgedRemovalBytes } = await import("../../packages/cache/main/identityStorage");
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    unacknowledgedRemovalBytes.current = STORAGE_PENDING_MAX_BYTES;

    expect(() => trackBlockedRemoval({
      chatId: -1001,
      probeMembership: false,
      userIds: [7],
    } as never)).toThrow("Storage pending write capacity was exhausted.");
    expect(pendingBlockedRemovals.size).toBe(0);
    expect(unacknowledgedRemovalWrites.size).toBe(0);
  });

  test("只改了内存的诊断在 write-ahead 时逐行发出；已随这一行写入发出的不再重复", async () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    const tracked = trackBlockedRemoval({ chatId: -1001, probeMembership: false, userIds: [7] } as never);
    const trackedRevision: number = unacknowledgedRemovalWrites.get(tracked.removalId)!.revision;
    postDiskIO.mockClear();

    updatePendingRemovalFailure(tracked.removalId, -1001, "worker-restarted");
    expect(postDiskIO).not.toHaveBeenCalled();
    expect([...unwrittenRemovalDiagnostics]).toEqual([tracked.removalId]);

    await persistPendingBlockedRemovals();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    const rowWrite = postDiskIO.mock.calls[0]?.[0] as {
      readonly type: string;
      readonly removalId: number;
      readonly data: string;
      readonly revision: number;
    };
    expect(rowWrite.type).toBe("blocklistRemovalWrite");
    expect(rowWrite.removalId).toBe(tracked.removalId);
    expect(rowWrite.revision).toBeGreaterThan(trackedRevision);
    expect(JSON.parse(rowWrite.data)).toEqual(expect.objectContaining({ attempts: 1, lastFailure: "worker-restarted" }));
    expect(unwrittenRemovalDiagnostics.size).toBe(0);

    // 这一行之后的任何一次写入都带着当前诊断，write-ahead 不再为它补发。
    updatePendingRemovalFailure(tracked.removalId, -1001, "worker-restarted");
    queueBlocklistRemovalWrite(tracked.removalId);
    postDiskIO.mockClear();
    await persistPendingBlockedRemovals();
    expect(postDiskIO).not.toHaveBeenCalled();
  });
});

/** 模拟 Disk I/O 事务 ACK：把一组 (removalId, revision) 回执交给已登记的 owner。 */
function acknowledgeRemovalWrites(writes: readonly { removalId: number; revision: number }[]): void {
  for (const listener of persistedListeners) {
    listener({
      type: "identityStoragePersisted",
      writes: [],
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      removalWrites: writes,
    });
  }
}

/** 记录重放投递的恢复传输替身；accept 决定每次投递是否被接收。 */
function recoveryTransport(accept: boolean): {
  readonly transport: DiskIORecoveryTransport;
  readonly posted: unknown[];
} {
  const posted: unknown[] = [];
  return {
    posted,
    transport: {
      post: (message: unknown): boolean => {
        posted.push(message);
        return accept;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("The blocklist outbox replay must not read the luck secret.");
      },
    },
  };
}

describe("逐行写入的精确 ACK 与 Disk I/O 重建重放", () => {
  test("同一行多次改写只留最新 revision；迟到的旧 ACK 不删更新的写", () => {
    pendingBlockedRemovals.set(...frozenTask(5, [7, 8]));
    expect(queueBlocklistRemovalWrite(5)).toBeTrue();
    const first: number = unacknowledgedRemovalWrites.get(5)!.revision;
    pendingBlockedRemovals.set(...frozenTask(5, [8]));
    expect(queueBlocklistRemovalWrite(5)).toBeTrue();
    const second: number = unacknowledgedRemovalWrites.get(5)!.revision;
    expect(second).toBeGreaterThan(first);
    expect(unacknowledgedRemovalWrites.size).toBe(1);

    acknowledgeRemovalWrites([{ removalId: 5, revision: first }]);
    expect(unacknowledgedRemovalWrites.get(5)?.revision).toBe(second);
    acknowledgeRemovalWrites([{ removalId: 5, revision: second }]);
    expect(unacknowledgedRemovalWrites.has(5)).toBeFalse();
  });

  test("Worker 重建后按 revision 顺序只重放未 ACK 的行，正文从当前镜像现编码，已删的行重放删除", async () => {
    pendingBlockedRemovals.set(...frozenTask(5, [7, 8]));
    pendingBlockedRemovals.set(...frozenTask(6, [7]));
    pendingBlockedRemovals.set(...frozenTask(7, [8]));
    queueBlocklistRemovalWrite(6);
    queueBlocklistRemovalWrite(5);
    queueBlocklistRemovalWrite(7);
    const revisions: ReadonlyMap<number, number> = new Map(
      [...unacknowledgedRemovalWrites].map(([removalId, write]): [number, number] => [removalId, write.revision])
    );
    acknowledgeRemovalWrites([{ removalId: 7, revision: revisions.get(7)! }]);
    // 已登记但尚未 ACK 的 6 号此后被删除：重放发出删除。
    pendingBlockedRemovals.delete(6);

    const replay: DiskIORespawnListener | undefined = respawnListeners.get("blocklist outbox");
    expect(replay).toBeDefined();
    const { transport, posted } = recoveryTransport(true);
    expect(await replay!(transport)).toBeTrue();
    expect(posted).toEqual([
      { type: "blocklistRemovalWrite", removalId: 6, data: null, revision: revisions.get(6) },
      {
        type: "blocklistRemovalWrite",
        removalId: 5,
        data: JSON.stringify(pendingBlockedRemovals.get(5)),
        revision: revisions.get(5),
      },
    ]);

    acknowledgeRemovalWrites([
      { removalId: 6, revision: revisions.get(6)! },
      { removalId: 5, revision: revisions.get(5)! },
    ]);
    posted.length = 0;
    expect(await replay!(transport)).toBeTrue();
    expect(posted).toEqual([]);
  });

  test("重放投递被拒时返回 false，未 ACK 的行原样保留", async () => {
    pendingBlockedRemovals.set(...frozenTask(6));
    expect(queueBlocklistRemovalWrite(6)).toBeTrue();
    const before = unacknowledgedRemovalWrites.get(6);

    const { transport, posted } = recoveryTransport(false);
    expect(await respawnListeners.get("blocklist outbox")!(transport)).toBeFalse();
    expect(posted).toHaveLength(1);
    expect(unacknowledgedRemovalWrites.get(6)).toEqual(before);
  });
});
