import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";

/**
 * 处置前那道身份闸的三态契约（packages/workers/antiRaid/adminCache.ts 的 isChatAdmin）。
 *
 * `undefined` 表示「没查出来」，调用方按不处置办。入群验证、刷屏禁言、广告处置等多处调用方会 mock 它，
 * 真实语义由本文件直接覆盖。
 */

const errorLogs: string[] = [];
const cachedAdmins = new Map<number, Set<number>>();
const fetchedAdmins = new Map<number, Set<number>>();
/** 返回里的机器人管理员（本机器人自己，或请求带 return_bots 时的其他机器人）。 */
const fetchedBotAdmins = new Map<number, Set<number>>();
const fetchOptions: unknown[] = [];
let fetchCalls: number = 0;

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: unknown): void { errorLogs.push(String(message)); } }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: {
    getChatAdministrators: async (
      chatId: number,
      other?: unknown
    ): Promise<{ user: { id: number; is_bot: boolean }; is_anonymous?: boolean }[]> => {
      fetchCalls++;
      fetchOptions.push(other);
      const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
      if (!admins) throw new Error("admin fetch failed");
      const bots: Set<number> = fetchedBotAdmins.get(chatId) ?? new Set();
      return [
        ...[...admins].map((id: number) => ({ user: { id, is_bot: false } })),
        ...[...bots].map((id: number) => ({ user: { id, is_bot: true } })),
      ];
    },
  },
}));
mock.module("../../../packages/workers/antiRaid/taskTracker", () => ({
  trackAntiRaidTask: <T>({ task }: { task: Promise<T> }): Promise<T> => task,
}));

const { isChatAdmin } = await import("../../../packages/workers/antiRaid/adminCache");
const { chatAdmins } = await import("../../../packages/cache/workers/antiRaid/admins");

beforeEach(() => {
  errorLogs.length = 0;
  cachedAdmins.clear();
  fetchedAdmins.clear();
  fetchedBotAdmins.clear();
  fetchOptions.length = 0;
  chatAdmins.clear();
  fetchCalls = 0;
});

/** 直接写进 owner 缓存，模拟入群守卫那边已经把这个群拉热了。 */
function seedFreshCache(chatId: number, adminIds: readonly number[]): void {
  chatAdmins.set(chatId, { adminIds: new Set(adminIds), fetchedAt: Date.now() });
}

describe("处置前的管理员身份闸", () => {
  test("缓存热时直接判定，不产生任何一次现拉", async () => {
    seedFreshCache(-1001, [7]);

    expect(await isChatAdmin(-1001, 7, "flooding user")).toBeTrue();
    expect(await isChatAdmin(-1001, 8, "flooding user")).toBeFalse();
    expect(fetchCalls).toBe(0);
  });

  test("缓存冷时现拉一次全量再判定", async () => {
    fetchedAdmins.set(-1001, new Set([7]));

    expect(await isChatAdmin(-1001, 7, "sender")).toBeTrue();
    expect(fetchCalls).toBe(1);
  });

  test("机器人即使是管理员也按普通成员处理：请求不带 return_bots，返回里的机器人也不进集合", async () => {
    fetchedAdmins.set(-1001, new Set([7]));
    fetchedBotAdmins.set(-1001, new Set([8]));

    expect(await isChatAdmin(-1001, 8, "sender")).toBeFalse();
    expect(await isChatAdmin(-1001, 7, "sender")).toBeTrue();
    expect(fetchCalls).toBe(1);
    expect(fetchOptions).toEqual([undefined]);
  });

  test("拉取失败返回 undefined 而不是 false：确证不了一律不处置", async () => {
    expect(await isChatAdmin(-1001, 7, "flooding user")).toBeUndefined();
    expect(errorLogs[0]).toContain("Failed to check admin exemption for flooding user 7 in chat -1001");
  });

  test("失败日志带上调用方的处置名，两条链路分得清是谁没查出来", async () => {
    await isChatAdmin(-1002, 9, "sender");

    expect(errorLogs[0]).toContain("Failed to check admin exemption for sender 9 in chat -1002");
  });
});
