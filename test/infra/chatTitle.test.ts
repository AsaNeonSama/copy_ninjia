import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GrammyError } from "grammy";
import { grammyApiError } from "../helpers/grammyError";
import { loggerStub } from "../helpers/loggerMock";
import {
  CHAT_ABSENCE_CONFIRM_ATTEMPTS,
  CHAT_ABSENCE_CONFIRM_INTERVAL_MS,
  CHAT_TITLE_REFRESH_CONCURRENCY,
} from "../../packages/consts/chatTeardown";
import { chatStateOf } from "../helpers/chatState";
import type { ChatState } from "../../packages/types/chatState";
import type { ChatDepartureReason } from "../../packages/types/chatTeardown";

const states = new Map<number, ChatState>();
const saveStateInBackground = mock((_context: string): void => {});
async function getChatStub(_chatId: number, _signal?: AbortSignal): Promise<{
  type: "supergroup";
  title: string;
}> {
  return { type: "supergroup", title: "title" };
}
const getChat = mock(getChatStub);
const loggerInfo = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});
const completeChatDeparture = mock(async (_chatId: number, _reason: ChatDepartureReason): Promise<void> => {});
/** 不可达确证的等待替身：默认立刻睡满；用例按需改写，模拟等待期间发生的事。 */
async function sleepUnlessAbortedStub(_ms: number, signal: AbortSignal): Promise<boolean> {
  return !signal.aborted;
}
const sleepUnlessAborted = mock(sleepUnlessAbortedStub);
const getChatState = mock((chatId: number) => states.get(chatId) ?? chatStateOf());

mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { getChat } } }));
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ info: loggerInfo, warn: loggerWarn, error: loggerError }),
}));
mock.module("../../packages/infra/botAdmin", () => ({ completeChatDeparture }));
mock.module("../../packages/libs/sleep", () => ({ sleepUnlessAborted }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: () => states,
  getChatState,
  getOrCreateChatState: (chatId: number) => states.get(chatId)!,
  saveChatStateInBackground: (_chatId: number, context: string): void => { saveStateInBackground(context); },
}));

const {
  abortChatTitleRefresh,
  initChatTitleRefresh,
  quiesceChatTitleRefresh,
  recordChatTitleFromChat,
  refreshAllChatTitles,
} = await import("../../packages/infra/chatTitle");

const CHAT_NOT_FOUND: GrammyError = grammyApiError(400, "Bad Request: chat not found");
const BOT_KICKED: GrammyError = grammyApiError(403, "Forbidden: bot was kicked from the supergroup chat");

beforeEach(() => {
  states.clear();
  getChat.mockReset();
  getChat.mockImplementation(getChatStub);
  saveStateInBackground.mockClear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  completeChatDeparture.mockReset();
  completeChatDeparture.mockResolvedValue(undefined);
  sleepUnlessAborted.mockReset();
  sleepUnlessAborted.mockImplementation(sleepUnlessAbortedStub);
  getChatState.mockClear();
  initChatTitleRefresh();
});

describe("chat title maintenance", () => {
  test("群消息入口复用调用方已读取的状态，不重复查表或改变写入语义", () => {
    const state: ChatState = chatStateOf({ isInitEnabled: true, title: "旧标题" });
    states.set(1, state);

    recordChatTitleFromChat(
      { id: 1, type: "supergroup", title: "新标题" },
      state
    );

    expect(getChatState).not.toHaveBeenCalled();
    expect(states.get(1)?.title).toBe("新标题");
    expect(saveStateInBackground).toHaveBeenCalledTimes(1);
  });

  test("每群各查一次、并发不超过标题刷新并发上限，全部独立结算", async () => {
    // 群数取并发上限的两倍，使并发上限起作用。
    const total: number = CHAT_TITLE_REFRESH_CONCURRENCY * 2;
    for (let chatId: number = 1; chatId <= total; chatId++) {
      states.set(chatId, chatStateOf({ isInitEnabled: true }));
    }
    let active: number = 0;
    let maxActive: number = 0;
    getChat.mockImplementation(async (chatId: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(0);
      active--;
      return { type: "supergroup" as const, title: `chat-${chatId}` };
    });

    await refreshAllChatTitles();

    expect(getChat).toHaveBeenCalledTimes(total);
    expect(maxActive).toBe(CHAT_TITLE_REFRESH_CONCURRENCY);
    // 每条标题只编码本群并入 Worker 事务缓冲，不重复序列化全量群快照。
    expect(saveStateInBackground).toHaveBeenCalledTimes(total);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining(`${total}/${total}`));
  });

  test("标题没变化的群不触发落盘", async () => {
    for (let chatId: number = 1; chatId <= 100; chatId++) {
      states.set(chatId, chatStateOf({ isInitEnabled: true, title: `chat-${chatId}` }));
    }
    getChat.mockImplementation(async (chatId: number) => ({
      type: "supergroup" as const,
      title: `chat-${chatId}`,
    }));

    await refreshAllChatTitles();

    expect(saveStateInBackground).not.toHaveBeenCalled();
  });

  test("不足一批的尾巴在收尾时落盘，不会留在内存里", async () => {
    for (let chatId: number = 1; chatId <= 3; chatId++) {
      states.set(chatId, chatStateOf({ isInitEnabled: true }));
    }
    getChat.mockImplementation(async (chatId: number) => ({
      type: "supergroup" as const,
      title: `chat-${chatId}`,
    }));

    await refreshAllChatTitles();

    expect(saveStateInBackground).toHaveBeenCalledTimes(3);
    expect(states.get(3)?.title).toBe("chat-3");
  });

  test("abort 后不再保存悬挂请求的迟到结果", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    let resolveChat!: () => void;
    getChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { resolveChat = resolve; });
      return { type: "supergroup" as const, title: "late-title" };
    });

    const refresh = refreshAllChatTitles();
    await Bun.sleep(0);
    abortChatTitleRefresh();
    resolveChat();
    await refresh;

    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(states.get(1)?.title).toBeUndefined();
  });
});

describe("启动时确证群已不可达", () => {
  test.each([
    ["gone", CHAT_NOT_FOUND],
    ["departed", BOT_KICKED],
  ] as const)("每次查询都得到同一结论（%s）才收尾，并记一条 warn", async (reason: ChatDepartureReason, error: GrammyError) => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (): Promise<never> => { throw error; });

    await refreshAllChatTitles();

    expect(getChat).toHaveBeenCalledTimes(CHAT_ABSENCE_CONFIRM_ATTEMPTS);
    expect(sleepUnlessAborted.mock.calls.map(([ms]: [number, AbortSignal]): number => ms))
      .toEqual(Array.from({ length: CHAT_ABSENCE_CONFIRM_ATTEMPTS - 1 }, (): number => CHAT_ABSENCE_CONFIRM_INTERVAL_MS));
    expect(completeChatDeparture.mock.calls).toEqual([[1, reason]]);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("迁移参数单独也判为群已不存在", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (): Promise<never> => { throw grammyApiError(400, "Bad Request: migrated", { migrate_to_chat_id: -1002 }); });

    await refreshAllChatTitles();

    expect(completeChatDeparture.mock.calls).toEqual([[1, "gone"]]);
  });

  test("中途查到群、结论变了或遇到别的错误都放弃，不收尾", async () => {
    for (const second of [
      async (): Promise<{ type: "supergroup"; title: string }> => ({ type: "supergroup", title: "回来了" }),
      async (): Promise<never> => { throw BOT_KICKED; },
      async (): Promise<never> => { throw grammyApiError(500, "Internal Server Error"); },
    ]) {
      states.set(1, chatStateOf({ isInitEnabled: true }));
      getChat.mockReset();
      getChat.mockImplementationOnce(async (): Promise<never> => { throw CHAT_NOT_FOUND; });
      getChat.mockImplementationOnce(second);
      getChat.mockImplementation(async (): Promise<never> => { throw CHAT_NOT_FOUND; });

      await refreshAllChatTitles();

      expect(getChat).toHaveBeenCalledTimes(2);
      expect(completeChatDeparture).not.toHaveBeenCalled();
    }
  });

  test("等待期间群已不在状态表里就不再查询、也不收尾", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (): Promise<never> => { throw CHAT_NOT_FOUND; });
    sleepUnlessAborted.mockImplementation(async (_ms: number, signal: AbortSignal): Promise<boolean> => {
      states.delete(1);
      return !signal.aborted;
    });

    await refreshAllChatTitles();

    expect(getChat).toHaveBeenCalledTimes(1);
    expect(completeChatDeparture).not.toHaveBeenCalled();
  });

  test("停机 quiesce 打断确证等待，任务随即结算、不收尾", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (): Promise<never> => { throw CHAT_NOT_FOUND; });
    sleepUnlessAborted.mockImplementation(async (_ms: number, signal: AbortSignal): Promise<boolean> => {
      quiesceChatTitleRefresh();
      return !signal.aborted;
    });

    await refreshAllChatTitles();

    expect(getChat).toHaveBeenCalledTimes(1);
    expect(completeChatDeparture).not.toHaveBeenCalled();
  });

  test("瞬时错误不进入确证，只记一行日志", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (): Promise<never> => { throw grammyApiError(429, "Too Many Requests: retry after 5"); });

    await refreshAllChatTitles();

    expect(sleepUnlessAborted).not.toHaveBeenCalled();
    expect(completeChatDeparture).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  test("收尾失败只记日志，不影响其它群的回填", async () => {
    states.set(1, chatStateOf({ isInitEnabled: true }));
    states.set(2, chatStateOf({ isInitEnabled: true }));
    getChat.mockImplementation(async (chatId: number): Promise<{ type: "supergroup"; title: string }> => {
      if (chatId === 1) throw CHAT_NOT_FOUND;
      return { type: "supergroup", title: "群二" };
    });
    completeChatDeparture.mockImplementationOnce(async (): Promise<void> => { throw new Error("teardown failed"); });

    await refreshAllChatTitles();

    expect(completeChatDeparture.mock.calls).toEqual([[1, "gone"]]);
    expect(states.get(2)?.title).toBe("群二");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
