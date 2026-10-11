/**
 * 部署配置写坏时（config/readiness.ts 判定失败）的统一拒绝边界 commands/configGate.ts：
 * 边界本身的判定，以及开关命令与 /mood switch/query 经它拒绝时不写入任何状态、点名具体坏掉的文件。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { groupCommandContext } from "../helpers/groupCommandContext";
import { loggerStub } from "../helpers/loggerMock";
import type { ConfigReadiness } from "../../packages/types/config";
import { replyCommandNoticeVia } from "../helpers/common";

const sendMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const persistChatState = mock(async (..._args: unknown[]): Promise<void> => {});
const loggerError = mock((..._args: unknown[]): void => {});
const clearAdDetection = mock((..._args: unknown[]): void => {});
const handleCopyCommand = mock(async (..._args: unknown[]): Promise<void> => {});
const queryAiMood = mock(async (): Promise<string> => "平静");
const switchAiMood = mock(async (): Promise<string> => "开心");
const states = new Map<number, Record<string, unknown>>();

function broken(file: string): ConfigReadiness {
  return { ok: false, failure: { file, reason: `Invalid ${file}: boom` } };
}

let aiChatVerdict: ConfigReadiness = { ok: true };
let adDetectVerdict: ConfigReadiness = { ok: true };
let jaTranslateVerdict: ConfigReadiness = { ok: true };

mock.module("../../packages/config/readiness", () => ({
  aiChatConfigReadiness: (): ConfigReadiness => aiChatVerdict,
  adDetectConfigReadiness: (): ConfigReadiness => adDetectVerdict,
  translateConfigReadiness: (): ConfigReadiness => jaTranslateVerdict,
}));
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  SUPER_ADMIN_USER_ID: 100,
}));
mock.module("../../packages/infra/telegram", () => ({
  sendCommandMessage: sendMessage,
  replyCommandNotice: replyCommandNoticeVia(sendMessage),
}));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("../../packages/aiChat", () => ({
  invalidateAiChat: mock((): void => {}),
  requestAiMood: (requestType: "queryMood" | "switchMood"): Promise<string> =>
    requestType === "queryMood" ? queryAiMood() : switchAiMood(),
}));
mock.module("../../packages/antiRaid", () => ({ clearAdDetection }));
mock.module("../../packages/commands/copy", () => ({ handleCopyCommand }));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getOrCreateChatState(chatId: number): Record<string, unknown> {
    let state = states.get(chatId);
    if (!state) {
      state = {};
      states.set(chatId, state);
    }
    return state;
  },
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getChatStateCache: (): ReadonlyMap<number, Record<string, unknown>> => states,
  persistChatState,
  persistGlobalState: async (): Promise<void> => {},
}));

const { refuseIfConfigBroken } = await import("../../packages/commands/configGate");
const { handleAiChatCommand } = await import("../../packages/commands/aiChat");
const { handleAdDetectCommand } = await import("../../packages/commands/adDetect");
const { handleTranslateCommand } = await import("../../packages/commands/translate");
const { handleMoodCommand } = await import("../../packages/commands/mood");

function context(argument: string): never {
  return groupCommandContext({ match: argument, messageId: 7 });
}

beforeEach(() => {
  states.clear();
  sendMessage.mockClear();
  persistChatState.mockClear();
  loggerError.mockClear();
  clearAdDetection.mockClear();
  handleCopyCommand.mockClear();
  queryAiMood.mockClear();
  switchAiMood.mockClear();
  aiChatVerdict = { ok: true };
  adDetectVerdict = { ok: true };
  jaTranslateVerdict = { ok: true };
});

describe("部署配置写坏时的 enable 拒绝", () => {
  test("/ai_chat enable 点名坏掉的那份文件，状态一个字都不改", async () => {
    aiChatVerdict = broken("config/dynamic/mood.json");
    await handleAiChatCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistChatState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/dynamic/mood.json"),
      replyToMessageId: 7,
    });
    // 用户看到的是中文文案，运维要的定位信息在日志里（英文，见 AGENTS.md）。
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("Invalid config/dynamic/mood.json"));
  });

  test("/ai_chat disable 不受配置影响：坏掉之后仍要能清残留开关", async () => {
    aiChatVerdict = broken("config/dynamic/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleAiChatCommand(context("disable"));

    expect(states.get(-1001)?.isAIChatEnabled).toBe(false);
    expect(persistChatState).toHaveBeenCalledWith(-1001, "ai_chat toggled");
  });

  test("/ad_detect enable 点名示例清单", async () => {
    adDetectVerdict = broken("config/dynamic/ad_samples.json");
    await handleAdDetectCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/dynamic/ad_samples.json"),
      replyToMessageId: 7,
    });
  });

  test("/translate enable 点名服务账号密钥", async () => {
    jaTranslateVerdict = broken("g-auth.json");
    await handleTranslateCommand(context("enable"));

    expect(states.size).toBe(0);
    expect(persistChatState).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("g-auth.json"),
      replyToMessageId: 7,
    });
  });

  test("/mood switch 也点名坏掉的心情表，不投递重抽请求", async () => {
    // 本群开着 AI 闲聊（配置是后来才被改坏的）：拒绝理由必须是那份文件，
    // 而不是「Worker 没回话」那条兜底文案。
    aiChatVerdict = broken("config/dynamic/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleMoodCommand(context("switch"));

    expect(switchAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/dynamic/mood.json"),
      replyToMessageId: 7,
    });
  });

  test("/mood query 也点名坏掉的心情表，不投递查询请求", async () => {
    aiChatVerdict = broken("config/dynamic/mood.json");
    states.set(-1001, { isAIChatEnabled: true });
    await handleMoodCommand(context("query"));

    expect(queryAiMood).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: -1001,
      text: expect.stringContaining("config/dynamic/mood.json"),
      replyToMessageId: 7,
    });
  });

  test("/translate 不带方向参数只提示用法", async () => {
    jaTranslateVerdict = broken("g-auth.json");
    await handleTranslateCommand(context(""));

    expect(handleCopyCommand).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("配置都读得动时三个开关照常写状态", async () => {
    await handleAiChatCommand(context("enable"));
    await handleAdDetectCommand(context("enable"));
    await handleTranslateCommand(context("enable"));

    expect(states.get(-1001)).toEqual({
      isAIChatEnabled: true,
      isAdDetectEnabled: true,
      isTranslationEnabled: true,
    });
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("refuseIfConfigBroken", () => {
  test("配置可用时什么都不做，返回 false", async () => {
    await expect(refuseIfConfigBroken({
      readiness: { ok: true },
      chatId: -1001,
      messageId: 7,
      feature: "Test feature",
      text: (file: string): string => `坏了：${file}`,
    })).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("配置不可用时记一行点名文件与原因的诊断，回复点名文件的拒绝，返回 true", async () => {
    await expect(refuseIfConfigBroken({
      readiness: broken("config/agent.json"),
      chatId: -1001,
      messageId: 7,
      feature: "Test feature",
      text: (file: string): string => `坏了：${file}`,
    })).resolves.toBe(true);
    expect(loggerError.mock.calls).toEqual([[
      "Test feature is unavailable in chat -1001: config/agent.json is unusable — Invalid config/agent.json: boom",
    ]]);
    expect(sendMessage.mock.calls).toEqual([[{ chatId: -1001, text: "坏了：config/agent.json", replyToMessageId: 7 }]]);
  });
});
