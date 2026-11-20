import { installTemporaryMessageWorkerMock } from "../../helpers/temporaryMessageWorkerMock";
import { ATMOSPHERE_TEXTS } from "../../../packages/consts/atmosphere";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../../packages/consts/commands";
installTemporaryMessageWorkerMock();
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { waitUntil } from "../../helpers/waitUntil";
import { loggerStub } from "../../helpers/loggerMock";
import type { BotActionPermissions } from "../../../packages/types/telegram";
import type { FloodCandidateMessage } from "../../../packages/types/antiRaid";
import type { FloodWindowEntry } from "../../../packages/types/antiRaid/internal";

const errorLogs: unknown[][] = [];
const sentTexts: string[] = [];
const deleteAfterCalls: {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: unknown;
}[] = [];
/** 每条公告请求带的取消信号；公告可能等待 grammY 消息桶。 */
const noticeSignals: (AbortSignal | undefined)[] = [];
const muteCalls: { chatId: number; userId: number; mutedUntil: number }[] = [];

/** 各群的管理员集合；undefined 表示缓存未命中，freshAdminIds 据此返回 undefined。 */
const cachedAdmins = new Map<number, Set<number>>();
const fetchedAdmins = new Map<number, Set<number>>();
let muteOutcome: "muted" | "forbidden" | "failed" = "muted";
/** 模拟三态之外的意外异常，验证处置的兜底 catch。 */
let muteThrows: boolean = false;
/** 模拟禁言通知发送抛出的异常（如超时/取消）。 */
let noticeError: Error | null = null;
let noticeMessageId: number | undefined = 500;
/** 把下一次禁言/身份确证卡在途中，模拟网络或分类 429 退避尚未结算的窗口。 */
let holdMute: boolean = false;
let releaseMute: (() => void) | undefined;
let holdAdminFetch: boolean = false;
let releaseAdminFetch: (() => void) | undefined;

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(...args: unknown[]): void { errorLogs.push(args); } }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: { kind: "guard-api" },
  muteChatMemberWithOutcome: async (
    params: { chatId: number; userId: number; mutedUntil: number; signal?: AbortSignal }
  ): Promise<string> => {
    muteCalls.push({ chatId: params.chatId, userId: params.userId, mutedUntil: params.mutedUntil });
    if (muteThrows) throw new Error("unexpected transport failure");
    if (holdMute) {
      holdMute = false;
      await new Promise<void>((resolve) => { releaseMute = resolve; });
    }
    // 真实实现里排队中的请求被 abort 就结算成 failed，原因由统一错误边界处理。
    if (params.signal?.aborted === true) return "failed";
    return muteOutcome;
  },
  sendMessage: async (params: { text: string; signal?: AbortSignal }): Promise<number | undefined> => {
    noticeSignals.push(params.signal);
    if (noticeError !== null) throw noticeError;
    // 真实实现里被 abort 的请求返回 undefined（错误由统一边界吞掉）。
    if (params.signal?.aborted === true) return undefined;
    sentTexts.push(params.text);
    return noticeMessageId;
  },
  deleteMessageAfter: (params: {
    chatId: number;
    messageId: number;
    delayMs: number;
    api?: unknown;
  }): void => {
    deleteAfterCalls.push(params);
  },
}));
const fetchAdminIds = async (chatId: number): Promise<Set<number>> => {
  if (holdAdminFetch) {
    holdAdminFetch = false;
    await new Promise<void>((resolve) => { releaseAdminFetch = resolve; });
  }
  const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
  if (!admins) throw new Error("admin fetch failed");
  return admins;
};

mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  freshAdminIds: (chatId: number): Set<number> | undefined => cachedAdmins.get(chatId),
  fetchAdminIds,
  // 三态契约的替身：先看缓存、冷了才现拉，拉不到一律 undefined（没查出来）。
  // 真实现见 packages/workers/antiRaid/adminCache.ts 的 isChatAdmin，由 test/workers/antiRaid/adminCache.test.ts 覆盖。
  isChatAdmin: async (chatId: number, userId: number): Promise<boolean | undefined> => {
    const cached: Set<number> | undefined = cachedAdmins.get(chatId);
    if (cached !== undefined) return cached.has(userId);
    try {
      return (await fetchAdminIds(chatId)).has(userId);
    } catch {
      // 格式与真实现一致；有用例断言这一行进入 logs/。
      errorLogs.push(["Failed to check admin exemption:", { chatId, userId, context: "flooding user" }]);
      return undefined;
    }
  },
}));

const {
  clearChatFloodWindows,
  formatFloodMuteNotice,
  handleFloodCandidate,
  observeMemberMessage,
  resetFloodWindows,
  sweepFloodWindows,
} = await import("../../../packages/workers/antiRaid/floodControl");
const {
  applyBotPermissionsChange,
  botCanDeleteIn,
  botCanRestrictIn,
  resetWorkerBotPermissions,
} = await import("../../../packages/workers/antiRaid/botPermissions");
const {
  floodWindowCacheStateHolder,
  floodWindowsByChat,
} = await import("../../../packages/cache/workers/antiRaid/flood");
const { antiRaidInFlightTasks } = await import("../../../packages/cache/workers/antiRaid/tasks");
const {
  quiesceAntiRaidDispatch,
  resetAntiRaidTaskTracker,
} = await import("../../../packages/workers/antiRaid/taskTracker");
const {
  FLOOD_MESSAGE_LIMIT,
  FLOOD_MUTE_DURATION_MS,
  FLOOD_WINDOW_MAX_MEMBERS,
  FLOOD_WINDOW_MS,
} = await import("../../../packages/consts/antiRaid/flood");

const FULL_RIGHTS: BotActionPermissions = { canRestrictMembers: true, canDeleteMessages: true };

function candidate(
  chatId: number = -1001,
  userId: number = 7,
  observedAt: number = Date.now()
): FloodCandidateMessage {
  return { type: "floodCandidate", chatId, userId, observedAt, name: "刷屏怪" };
}

/** 测试读取分层数值索引（群 id → 发送者 id）。 */
function floodEntry(chatId: number, userId: number): FloodWindowEntry | undefined {
  return floodWindowsByChat.get(chatId)?.get(userId);
}

/** 连投 count 条并等待派生的后台任务结算。 */
async function flood(count: number, message: FloodCandidateMessage = candidate()): Promise<void> {
  for (let i: number = 0; i < count; i++) handleFloodCandidate(message);
  await Promise.allSettled([...antiRaidInFlightTasks]);
}

beforeEach(() => {
  resetFloodWindows();
  resetWorkerBotPermissions();
  cachedAdmins.clear();
  fetchedAdmins.clear();
  errorLogs.length = 0;
  sentTexts.length = 0;
  deleteAfterCalls.length = 0;
  noticeSignals.length = 0;
  muteCalls.length = 0;
  muteOutcome = "muted";
  muteThrows = false;
  noticeError = null;
  noticeMessageId = 500;
  holdMute = false;
  releaseMute = undefined;
  holdAdminFetch = false;
  releaseAdminFetch = undefined;
  // 停机用的取消控制器 abort 后不可复位，每个用例换新的。
  resetAntiRaidTaskTracker();
  // 默认：机器人有限制成员权限，目标不是管理员。
  applyBotPermissionsChange(-1001, FULL_RIGHTS);
  cachedAdmins.set(-1001, new Set([42]));
});

afterEach(() => {
  resetFloodWindows();
  resetWorkerBotPermissions();
});

describe("刷屏发言窗口", () => {
  test("差一条不算刷屏，压垮窗口的那一条才交回条目供调用方置抑制位", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      expect(observeMemberMessage(-1001, 7, 1_000 + i)).toBeUndefined();
    }
    expect(observeMemberMessage(-1001, 7, 1_000 + FLOOD_MESSAGE_LIMIT))
      .toBe(floodEntry(-1001, 7)!);
  });

  test("投递自带主线程观测时刻，本线程不为每条候选再读一次墙钟", () => {
    const observedAt: number = 1_800_000_000_000;
    // 夹具先造好：candidate() 的默认时刻会读一次钟，不计入本用例。
    const message: FloodCandidateMessage = candidate(-1001, 7, observedAt);
    const nowSpy: ReturnType<typeof spyOn> = spyOn(Date, "now");
    try {
      handleFloodCandidate(message);
      expect(nowSpy).not.toHaveBeenCalled();
      expect(floodEntry(-1001, 7)?.lastObservedAt).toBe(observedAt);
      expect(floodEntry(-1001, 7)?.timestamps.peek()).toBe(observedAt);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("命中后窗口整体清空：禁言没打成时也要再刷满一整个窗口才会重来", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) {
      observeMemberMessage(-1001, 7, 1_000 + i);
    }
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(0);

    expect(observeMemberMessage(-1001, 7, 2_000)).toBeUndefined();
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(1);
  });

  test("滑出一分钟窗口的发言不再累计", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      observeMemberMessage(-1001, 7, 1_000);
    }
    expect(observeMemberMessage(-1001, 7, 1_000 + FLOOD_WINDOW_MS)).toBeUndefined();
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(1);
  });

  test("时钟大幅回拨时裁剪未来时间戳，不把后续正常发言堆积在旧时刻误触发禁言", () => {
    const initialAt: number = 10_000_000;
    observeMemberMessage(-1001, 7, initialAt);
    const rolledBackStart: number = 1_000_000;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) {
      expect(observeMemberMessage(-1001, 7, rolledBackStart + i * FLOOD_WINDOW_MS)).toBeUndefined();
    }
    expect(floodEntry(-1001, 7)?.timestamps.size).toBe(1);
    expect(floodEntry(-1001, 7)?.lastObservedAt)
      .toBe(rolledBackStart + (FLOOD_MESSAGE_LIMIT - 1) * FLOOD_WINDOW_MS);
  });

  test("抑制期内到达的消息既不计数也不重复触发", () => {
    observeMemberMessage(-1001, 7, 1_000);
    const entry: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(entry).toBeDefined();
    entry!.suppressedUntil = 1_000 + FLOOD_MUTE_DURATION_MS;

    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT * 2; i++) {
      expect(observeMemberMessage(-1001, 7, 2_000 + i)).toBeUndefined();
    }
    expect(entry!.timestamps.size).toBe(1);
  });

  test("墙钟回拨使 suppressedUntil 远超单档禁言时长时结束抑制并恢复刷屏计数", () => {
    const initialAt: number = 10_000_000;
    observeMemberMessage(-1001, 7, initialAt);
    const entry: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(entry).toBeDefined();
    entry!.suppressedUntil = initialAt + FLOOD_MUTE_DURATION_MS;

    const rolledBackNow: number = initialAt - 1;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      expect(observeMemberMessage(-1001, 7, rolledBackNow)).toBeUndefined();
    }
    expect(observeMemberMessage(-1001, 7, rolledBackNow)).toBe(entry!);
  });

  test("群与成员各自计数，互不连累", () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT - 1; i++) {
      observeMemberMessage(-1001, 7, 1_000 + i);
    }
    expect(observeMemberMessage(-2002, 7, 1_100)).toBeUndefined();
    expect(observeMemberMessage(-1001, 8, 1_100)).toBeUndefined();
    expect(observeMemberMessage(-1001, 7, 1_100)).toBeDefined();
  });

  test("条目数达到全局硬顶后跨群按精确 LRU 淘汰", () => {
    for (let member: number = 1; member <= FLOOD_WINDOW_MAX_MEMBERS; member++) {
      observeMemberMessage(-1001, member, 1_000);
    }
    observeMemberMessage(-1001, 1, 2_000);
    const oldestBeforeEviction: FloodWindowEntry | undefined = floodEntry(-1001, 2);
    expect(oldestBeforeEviction).toBeDefined();
    const recycledDeque = oldestBeforeEviction!.timestamps;

    observeMemberMessage(-2002, 1, 2_000);

    const inserted: FloodWindowEntry | undefined = floodEntry(-2002, 1);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(FLOOD_WINDOW_MAX_MEMBERS);
    expect(floodEntry(-1001, 1)).toBeDefined();
    expect(floodEntry(-1001, 2)).toBeUndefined();
    expect(inserted).toBeDefined();
    // 满载驱逐只复用被驱逐条目的时间戳队列并清空旧内容，条目对象本身保持新建。
    expect(inserted).not.toBe(oldestBeforeEviction!);
    expect(inserted!.timestamps).toBe(recycledDeque);
    expect(inserted!.timestamps.size).toBe(1);
    expect(inserted!.timestamps.peek()).toBe(2_000);
  });

  test("满载驱逐复用 timestamps 时保留在途禁言任务的引用同一性（stillManaged 失效且不污染新条目）", async () => {
    cachedAdmins.delete(-1001);
    fetchedAdmins.set(-1001, new Set([42]));
    holdAdminFetch = true;

    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) {
      handleFloodCandidate(candidate(-1001, 7, 1_000 + i));
    }
    expect(await waitUntil((): boolean => releaseAdminFetch !== undefined)).toBe(true);
    const evictedEntry: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(evictedEntry).toBeDefined();

    // 填满其余槽位并再多插入一条，把 (-1001, 7) 作为最旧条目挤出缓存。
    for (let member: number = 1; member <= FLOOD_WINDOW_MAX_MEMBERS; member++) {
      observeMemberMessage(-2002, member, 2_000 + member);
    }
    expect(floodEntry(-1001, 7)).toBeUndefined();
    const replacement: FloodWindowEntry | undefined = floodEntry(-2002, FLOOD_WINDOW_MAX_MEMBERS);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(evictedEntry!);
    expect(replacement!.timestamps).toBe(evictedEntry!.timestamps);

    // 即使原成员立刻重新发言建回新条目，在途任务持有的是旧条目对象，不得继续禁言。
    observeMemberMessage(-1001, 7, 30_000);
    const recreated: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(recreated).toBeDefined();
    expect(recreated).not.toBe(evictedEntry!);

    releaseAdminFetch!();
    await Promise.allSettled([...antiRaidInFlightTasks]);

    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
    expect(replacement!.suppressedUntil).toBe(0);
    expect(recreated!.suppressedUntil).toBe(0);
  });

  test("满载随机序列（驱逐、LRU 命中、抑制、回拨、清扫与清群）与不复用队列的参考模型完全等价", () => {
    interface RefEntry {
      readonly chatId: number;
      readonly userId: number;
      timestamps: number[];
      lastObservedAt: number;
      suppressedUntil: number;
    }

    const activeChats: readonly number[] = [-3001, -3002];
    const activeUserCount: number = 3;
    const fillerChatId: number = -9999;

    const refOrder = new Map<string, RefEntry>();
    const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`;

    const refObserve = (chatId: number, userId: number, now: number): boolean => {
      const key: string = keyOf(chatId, userId);
      let entry: RefEntry | undefined = refOrder.get(key);
      if (entry === undefined) {
        if (refOrder.size >= FLOOD_WINDOW_MAX_MEMBERS) {
          const oldestKey: string | undefined = refOrder.keys().next().value;
          if (oldestKey !== undefined) refOrder.delete(oldestKey);
        }
        entry = { chatId, userId, timestamps: [], lastObservedAt: now, suppressedUntil: 0 };
        refOrder.set(key, entry);
      } else {
        refOrder.delete(key);
        refOrder.set(key, entry);
      }
      entry.lastObservedAt = now;
      if (
        entry.suppressedUntil > now &&
        entry.suppressedUntil - now <= FLOOD_MUTE_DURATION_MS
      ) {
        return false;
      }
      while (entry.timestamps.length > 0 && entry.timestamps[entry.timestamps.length - 1]! > now) {
        entry.timestamps.pop();
      }
      const cutoff: number = now - FLOOD_WINDOW_MS;
      while (entry.timestamps.length > 0 && entry.timestamps[0]! <= cutoff) {
        entry.timestamps.shift();
      }
      entry.timestamps.push(now);
      if (entry.timestamps.length < FLOOD_MESSAGE_LIMIT) return false;
      entry.timestamps = [];
      return true;
    };

    const refSweep = (now: number): number => {
      let deleted: number = 0;
      for (const [key, entry] of [...refOrder.entries()]) {
        const suppressed: boolean =
          entry.suppressedUntil > now &&
          entry.suppressedUntil - now <= FLOOD_MUTE_DURATION_MS;
        if (suppressed) continue;
        const activeWindow: boolean =
          now >= entry.lastObservedAt &&
          now - entry.lastObservedAt <= FLOOD_WINDOW_MS;
        if (activeWindow) continue;
        refOrder.delete(key);
        deleted++;
      }
      return deleted;
    };

    const refClearChat = (chatId: number): void => {
      for (const [key, entry] of [...refOrder.entries()]) {
        if (entry.chatId === chatId) refOrder.delete(key);
      }
    };

    // 先填满全局硬顶，再在满载边界上连续跑 300 组随机序列持续触发驱逐与 timestamps 队列复用。
    let now: number = 10_000_000;
    let nextFillerUser: number = 1;
    let nextEphemeralUser: number = 100_000;
    const ensureAtCapacity = (): void => {
      while (refOrder.size < FLOOD_WINDOW_MAX_MEMBERS) {
        const fillerUser: number = nextFillerUser++;
        observeMemberMessage(fillerChatId, fillerUser, now);
        refObserve(fillerChatId, fillerUser, now);
      }
    };

    let rng: number = 0x5eed_cafe;
    const nextRand = (bound: number): number => {
      rng = (rng * 1_664_525 + 1_013_904_223) >>> 0;
      return rng % bound;
    };

    ensureAtCapacity();
    let totalEvictionsObserved: number = 0;
    let totalTriggersObserved: number = 0;

    for (let sequence: number = 0; sequence < 300; sequence++) {
      ensureAtCapacity();
      for (let step: number = 0; step < 30; step++) {
        const action: number = nextRand(20);
        if (action === 0) {
          // 偶发小幅时钟回拨
          now = Math.max(1_000, now - (1 + nextRand(2_000)));
        } else {
          now += nextRand(400);
        }
        const chatId: number = activeChats[nextRand(activeChats.length)]!;
        // 混合高频复访成员（构造多条时间戳与触发禁言）与全新访客（强制触发满载驱逐与 deque 复用）。
        const userId: number = action < 7
          ? nextEphemeralUser++
          : 1 + nextRand(activeUserCount);
        const wasAtCap: boolean =
          floodWindowCacheStateHolder.current.entryCount >= FLOOD_WINDOW_MAX_MEMBERS &&
          floodEntry(chatId, userId) === undefined;
        const actualTriggered: FloodWindowEntry | undefined = observeMemberMessage(chatId, userId, now);
        const expectedTriggered: boolean = refObserve(chatId, userId, now);
        if (wasAtCap) totalEvictionsObserved++;
        if (expectedTriggered) totalTriggersObserved++;
        expect(actualTriggered !== undefined).toBe(expectedTriggered);
        if (actualTriggered !== undefined) {
          const until: number = actualTriggered.lastObservedAt + FLOOD_MUTE_DURATION_MS;
          actualTriggered.suppressedUntil = until;
          refOrder.get(keyOf(chatId, userId))!.suppressedUntil = until;
        }
      }

      if (sequence % 25 === 24) {
        const chatId: number = activeChats[nextRand(activeChats.length)]!;
        clearChatFloodWindows(chatId);
        refClearChat(chatId);
      }
      if (sequence % 60 === 59) {
        const sweepNow: number = now + FLOOD_WINDOW_MS + 1;
        const actualDeleted: number = sweepFloodWindows(sweepNow);
        const expectedDeleted: number = refSweep(sweepNow);
        expect(actualDeleted).toBe(expectedDeleted);
        now = sweepNow;
      }

      // 每组序列结束后核对总数、活跃条目时间戳内容与 LRU 头尾一致。
      expect(floodWindowCacheStateHolder.current.entryCount).toBe(refOrder.size);
      for (const chatId of activeChats) {
        for (let userId: number = 1; userId <= activeUserCount; userId++) {
          const actual: FloodWindowEntry | undefined = floodEntry(chatId, userId);
          const expected: RefEntry | undefined = refOrder.get(keyOf(chatId, userId));
          expect(actual !== undefined).toBe(expected !== undefined);
          if (actual !== undefined && expected !== undefined) {
            expect(actual.lastObservedAt).toBe(expected.lastObservedAt);
            expect(actual.suppressedUntil).toBe(expected.suppressedUntil);
            expect(actual.timestamps.size).toBe(expected.timestamps.length);
            for (let idx: number = 0; idx < expected.timestamps.length; idx++) {
              expect(actual.timestamps.peekAt(idx)).toBe(expected.timestamps[idx]);
            }
          }
        }
      }
      const oldestRef: RefEntry | undefined = refOrder.values().next().value;
      if (oldestRef === undefined) {
        expect(floodWindowCacheStateHolder.current.oldest).toBeNull();
        expect(floodWindowCacheStateHolder.current.newest).toBeNull();
      } else {
        expect(floodWindowCacheStateHolder.current.oldest?.chatId).toBe(oldestRef.chatId);
        expect(floodWindowCacheStateHolder.current.oldest?.userId).toBe(oldestRef.userId);
      }
    }
    expect(totalEvictionsObserved).toBeGreaterThan(2_000);
    expect(totalTriggersObserved).toBeGreaterThan(0);
  });

  test("统一 sweep 删掉空闲满一个窗口的条目，仍在抑制期的留到抑制结束", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_000);
    floodEntry(-1001, 8)!.suppressedUntil = 1_000 + FLOOD_MUTE_DURATION_MS;

    expect(sweepFloodWindows(1_000 + FLOOD_WINDOW_MS)).toBe(0);
    expect(sweepFloodWindows(1_001 + FLOOD_WINDOW_MS)).toBe(1);
    expect(floodEntry(-1001, 7)).toBeUndefined();
    // 抑制还没到点：条目保留。
    expect(floodEntry(-1001, 8)).toBeDefined();
    expect(sweepFloodWindows(2_000 + FLOOD_MUTE_DURATION_MS)).toBe(1);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(0);
  });

  test("墙钟回拨时 sweep 回收早于 lastObservedAt 的空闲条目与远超单档时长的抑制条目", () => {
    const recordedAt: number = 10_000_000;
    observeMemberMessage(-1001, 7, recordedAt);
    observeMemberMessage(-1001, 8, recordedAt);
    floodEntry(-1001, 8)!.suppressedUntil = recordedAt + FLOOD_MUTE_DURATION_MS;

    expect(sweepFloodWindows(recordedAt - 1)).toBe(2);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(0);
    expect(floodWindowsByChat.size).toBe(0);
  });

  test("停管/`/init disable` 丢掉该群全部窗口，别的群不受影响", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_000);
    observeMemberMessage(-2002, 7, 1_000);

    clearChatFloodWindows(-1001);
    expect([...floodWindowsByChat.keys()]).toEqual([-2002]);
    expect(floodWindowCacheStateHolder.current.entryCount).toBe(1);
    const remaining: FloodWindowEntry | undefined = floodEntry(-2002, 7);
    expect(floodWindowCacheStateHolder.current.newest).toBe(remaining!);
    expect(floodWindowCacheStateHolder.current.oldest).toBe(remaining!);
    expect(remaining?.lruNewer).toBeNull();
    expect(remaining?.lruOlder).toBeNull();
  });

  test("reset 摘掉外部仍持有条目的 LRU 引用，避免一条在途任务留住整张表", () => {
    observeMemberMessage(-1001, 7, 1_000);
    observeMemberMessage(-1001, 8, 1_001);
    const retained: FloodWindowEntry | undefined = floodEntry(-1001, 7);
    expect(retained?.lruNewer).toBeDefined();

    resetFloodWindows();

    expect(retained?.lruNewer).toBeNull();
    expect(retained?.lruOlder).toBeNull();
    expect(floodWindowsByChat.size).toBe(0);
    expect(floodWindowCacheStateHolder.current).toEqual({
      entryCount: 0,
      newest: null,
      oldest: null,
    });
  });
});

describe("机器人自身权限镜像", () => {
  test("镜像是三态：「没观测到」与「观测到没有」必须分得开", () => {
    applyBotPermissionsChange(-3003, { canRestrictMembers: true, canDeleteMessages: false });
    expect(botCanRestrictIn(-3003)).toBeTrue();
    expect(botCanDeleteIn(-3003)).toBeFalse();

    // 从没镜像过的群是 undefined，不是 false：「确证没权限」与「还不知道」分别处置。
    expect(botCanRestrictIn(-4004)).toBeUndefined();
    expect(botCanDeleteIn(-4004)).toBeUndefined();

    // 主线程对撤管理员/离群/现查失败发的都是「未知」，不沿用旧值。
    applyBotPermissionsChange(-3003, undefined);
    expect(botCanRestrictIn(-3003)).toBeUndefined();

    // 停管同样以「未知」丢掉已确证的权限。
    applyBotPermissionsChange(-3003, FULL_RIGHTS);
    applyBotPermissionsChange(-3003, undefined);
    expect(botCanRestrictIn(-3003)).toBeUndefined();
  });
});

describe("刷屏禁言的处置", () => {
  test("越过阈值即禁言并播报，公告三十秒后由主线程删除", async () => {
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(muteCalls).toHaveLength(1);
    expect(muteCalls[0]).toMatchObject({ chatId: -1001, userId: 7 });
    expect(muteCalls[0]!.mutedUntil).toBeGreaterThan(Date.now());
    expect(sentTexts).toEqual([formatFloodMuteNotice("刷屏怪", ATMOSPHERE_TEXTS.teasing)]);
    expect(deleteAfterCalls).toEqual([{
      chatId: -1001,
      messageId: 500,
      delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
      api: { kind: "guard-api" },
    }]);
  });

  test("展示名在禁言时才清洗：控制字符与连续空白收拢，清洗后为空退化为本进程风格的兜底称呼", async () => {
    await flood(FLOOD_MESSAGE_LIMIT, { ...candidate(), name: "\u202e刷屏  怪 " });
    expect(sentTexts).toEqual([formatFloodMuteNotice("刷屏 怪", ATMOSPHERE_TEXTS.teasing)]);

    sentTexts.length = 0;
    await flood(FLOOD_MESSAGE_LIMIT, { ...candidate(-1001, 8), name: "\u2066\u2069" });
    expect(sentTexts).toEqual([
      formatFloodMuteNotice(ATMOSPHERE_TEXTS.teasing.NOTICE_TEXTS.unknownUser, ATMOSPHERE_TEXTS.teasing),
    ]);
  });

  test("回归用例：停机 flush 按群合批，几条公告只花一个请求——逐条发会把 drain 拖过预算", async () => {
    // 同一个群里几名成员接连刷屏，册子上有好几条待删公告；停机 flush 按群合批，同群公告只发一个请求。
    for (const [index, userId] of [11, 12, 13, 14].entries()) {
      noticeMessageId = 600 + index;
      await flood(FLOOD_MESSAGE_LIMIT, candidate(-1001, userId));
    }
    // 另一个群单独一条：deleteMessages 不跨 chat 合批，各自一个请求。
    applyBotPermissionsChange(-1002, FULL_RIGHTS);
    cachedAdmins.set(-1002, new Set([42]));
    noticeMessageId = 700;
    await flood(FLOOD_MESSAGE_LIMIT, candidate(-1002, 21));

    expect(deleteAfterCalls.map((entry) => [entry.chatId, entry.messageId]))
      .toEqual([
        [-1001, 600], [-1001, 601], [-1001, 602], [-1001, 603],
        [-1002, 700],
      ]);
  });

  test("禁言期间还在路上的消息不会换来第二次禁言", async () => {
    await flood(FLOOD_MESSAGE_LIMIT * 2);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
  });

  test("没有确证的限制成员权限时一个请求都不发，且一场刷屏只留一行诊断", async () => {
    applyBotPermissionsChange(-1001, { canRestrictMembers: false, canDeleteMessages: true });
    await flood(FLOOD_MESSAGE_LIMIT * 2);
    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
    // 结论在权限变回来之前不变，抑制位保留，一场刷屏只记一行。
    expect(errorLogs).toEqual([[
      "Flood control cannot mute user; the bot does not have permission to restrict members.",
      { chatId: -1001, userId: 7 },
    ]]);
  });

  test("目标是群管理员时不禁言，且不刷「机器人没权限」的假线索", async () => {
    cachedAdmins.set(-1001, new Set([7]));
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toBeEmpty();
    expect(errorLogs).toBeEmpty();
  });

  test("管理员身份确证不了时不动手：放过一次刷屏好过把群主按住", async () => {
    // 缓存冷 + 全量拉取失败 = 查不出身份。
    cachedAdmins.delete(-1001);
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toBeEmpty();
    expect(errorLogs[0]).toEqual([
      "Failed to check admin exemption:",
      { chatId: -1001, userId: 7, context: "flooding user" },
    ]);

    // 冷缓存但拉得到时照常处置。
    fetchedAdmins.set(-1001, new Set([42]));
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
  });

  test("禁言没落地就不播报——公告断言的是「人已经被按住了」", async () => {
    muteOutcome = "failed";
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toBeEmpty();
    expect(deleteAfterCalls).toBeEmpty();

    // 限流/抖动是瞬时失败：抑制位回滚，再刷满一整个窗口会重试。
    muteOutcome = "muted";
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(2);
  });

  test("Telegram 明确拒绝时保留抑制位，不让一场刷屏反复重打注定失败的请求", async () => {
    muteOutcome = "forbidden";
    await flood(FLOOD_MESSAGE_LIMIT * 3);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toBeEmpty();
  });

  test("权限镜像还没到时照常尝试，由 Telegram 当裁判", async () => {
    // 权限镜像未到（未知）不等于确证没有权限，照常尝试。
    applyBotPermissionsChange(-1001, undefined);
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
    // 这条路径不记「机器人没有限制成员权限」。
    expect(errorLogs).toBeEmpty();
  });

  test("公告发不出去时不排自删计时器", async () => {
    noticeMessageId = undefined;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(deleteAfterCalls).toBeEmpty();
  });

  test("处置意外抛错时回滚抑制位并留下诊断，下一个满窗口照常重试", async () => {
    muteThrows = true;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(sentTexts).toBeEmpty();
    expect(errorLogs).toContainEqual([
      "Failed to mute flooding user:",
      { chatId: -1001, userId: 7 },
      expect.any(Error),
    ]);

    muteThrows = false;
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(2);
    expect(sentTexts).toHaveLength(1);
  });

  test("禁言任务登记进在途集合，停机 drain 会等它结算", async () => {
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    expect(antiRaidInFlightTasks.size).toBe(1);
    await Promise.allSettled([...antiRaidInFlightTasks]);
    expect(antiRaidInFlightTasks.size).toBe(0);
  });

  test("回归用例：公告也带派发截止时间，不能在消息桶里排成迟到噪音", async () => {
    // 公告与验证提醒等功能性消息共享 grammY message 桶，踢人使用独立 kick 类别；公告带派发截止时间。
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(sentTexts).toHaveLength(1);
    expect(noticeSignals).toHaveLength(1);
    expect(noticeSignals[0]).toBeInstanceOf(AbortSignal);
    expect(noticeSignals[0]!.aborted).toBeFalse();
  });

  test("回归用例：drain 已经开始时连身份确证都不发——禁言的派发窗口是分钟级，drain 的预算是秒级", async () => {
    quiesceAntiRaidDispatch();
    await flood(FLOOD_MESSAGE_LIMIT);

    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
  });

  test("回归用例：禁言已经排上队时 drain 就地撤掉它，不发那条公告", async () => {
    // 禁言请求最长排 FLOOD_MUTE_DISPATCH_TIMEOUT_MS；drain 到达时就地撤掉已排上队的禁言。
    holdMute = true;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    expect(await waitUntil((): boolean => releaseMute !== undefined)).toBe(true);
    expect(muteCalls).toHaveLength(1);

    quiesceAntiRaidDispatch();
    releaseMute!();
    await Promise.allSettled([...antiRaidInFlightTasks]);

    expect(sentTexts).toBeEmpty();
    expect(deleteAfterCalls).toBeEmpty();
  });

  test("回归用例：身份确证期间群被停管，就不再禁言、也不往那个群里说话", async () => {
    // 缓存冷时身份确证是一整次 getChatAdministrators；期间 `/init disable` 经 deactivateChat → clearChatFloodWindows
    // 丢掉这个群的全部窗口，确证返回后不再禁言、不再发言。
    cachedAdmins.delete(-1001);
    fetchedAdmins.set(-1001, new Set([42]));
    holdAdminFetch = true;
    for (let i: number = 0; i < FLOOD_MESSAGE_LIMIT; i++) handleFloodCandidate(candidate());
    expect(await waitUntil((): boolean => releaseAdminFetch !== undefined)).toBe(true);

    clearChatFloodWindows(-1001);
    releaseAdminFetch!();
    await Promise.allSettled([...antiRaidInFlightTasks]);

    expect(muteCalls).toBeEmpty();
    expect(sentTexts).toBeEmpty();
  });

  test("播报只说清谁被按了多久，不回显刷屏内容", () => {
    const notice: string = formatFloodMuteNotice("@noisy", ATMOSPHERE_TEXTS.teasing);
    expect(notice).toContain("@noisy");
    expect(notice).toContain(String(FLOOD_MESSAGE_LIMIT));
    expect(notice).toContain(`${FLOOD_MUTE_DURATION_MS / 60_000} 分钟`);
    // 文案只由标签与两个常量拼成，不带消息正文。
    expect(notice).not.toContain("spam");
  });

  test("禁言成功后通知发送抛错仍保留抑制位：普通异常仅记通知失败，AbortError 不记错误日志", async () => {
    noticeError = new Error("notice transport failed");
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);
    expect(errorLogs).toEqual([[
      "Failed to send flood mute notice:",
      { chatId: -1001, userId: 7 },
      noticeError,
    ]]);

    // 抑制位必须保留，同一窗口期内继续刷屏不得再次禁言。
    await flood(FLOOD_MESSAGE_LIMIT);
    expect(muteCalls).toHaveLength(1);

    // 换另一个用户触发禁言成功，若通知因 AbortError 取消，保留抑制位且不记 error。
    errorLogs.length = 0;
    noticeError = new DOMException("aborted", "AbortError");
    await flood(FLOOD_MESSAGE_LIMIT, candidate(-1001, 8));
    expect(muteCalls).toHaveLength(2);
    expect(errorLogs).toBeEmpty();
    await flood(FLOOD_MESSAGE_LIMIT, candidate(-1001, 8));
    expect(muteCalls).toHaveLength(2);
  });
});
