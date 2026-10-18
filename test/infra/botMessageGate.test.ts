import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { botMessageActivity } from "../../packages/cache/main/botMessage";
import {
  BOT_MESSAGE_ACTIVITY_LIMIT,
  BOT_MESSAGE_ACTIVITY_MAX_ENTRIES,
  BOT_MESSAGE_ACTIVITY_TTL_MS,
} from "../../packages/consts/botMessage";
import { shouldPassBotMessage } from "../../packages/infra/botMessageGate";
import { chatStateCache } from "../../packages/cache/main/chatState";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";
import type { Message } from "grammy/types";

const OWN_BOT_ID: number = 999;
const CHAT_ID: number = -1001;
const OTHER_CHAT_ID: number = -1002;

function message(botId: number, isBot: boolean = true, chatId: number = CHAT_ID): Message {
  return { chat: { id: chatId, type: "supergroup" }, from: { id: botId, is_bot: isBot } } as Message;
}

beforeEach((): void => {
  jest.useFakeTimers({ now: 1_000_000 });
  botMessageActivity.clear();
  chatStateCache.clear();
});

afterEach((): void => {
  for (const activity of botMessageActivity.values()) {
    if (activity.timer !== null) clearTimeout(activity.timer);
  }
  botMessageActivity.clear();
  chatStateCache.clear();
  jest.useRealTimers();
});

describe("主线程 Bot-to-Bot 发言限流", () => {
  test("同一 bot id 累计，前 15 条放行，第 16 条起拦截", () => {
    const incoming: Message = message(42);
    for (let index: number = 0; index < BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    }
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
    expect(botMessageActivity.get(42)?.count).toBe(BOT_MESSAGE_ACTIVITY_LIMIT + 1);
    expect(shouldPassBotMessage(message(43), OWN_BOT_ID)).toBeTrue();
  });

  test("非机器人、频道身份、自身回投与非消息更新不占额度", () => {
    const initialTimers: number = jest.getTimerCount();
    expect(shouldPassBotMessage(undefined, OWN_BOT_ID)).toBeTrue();
    expect(shouldPassBotMessage(message(42, false), OWN_BOT_ID)).toBeTrue();
    for (let index: number = 0; index <= BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      expect(shouldPassBotMessage(message(OWN_BOT_ID), OWN_BOT_ID)).toBeTrue();
    }
    expect(shouldPassBotMessage({ ...message(42), sender_chat: { id: -1 } } as Message, OWN_BOT_ID)).toBeTrue();
    expect(botMessageActivity.size).toBe(0);
    expect(jest.getTimerCount()).toBe(initialTimers);
  });

  test("本群 /delete_message 目标的机器人发言先放行且不计数；别的群照常计数", () => {
    getOrCreateChatState(CHAT_ID).deleteMessageTargets = [42];
    const initialTimers: number = jest.getTimerCount();
    for (let index: number = 0; index <= BOT_MESSAGE_ACTIVITY_LIMIT * 2; index += 1) {
      expect(shouldPassBotMessage(message(42), OWN_BOT_ID)).toBeTrue();
    }
    expect(botMessageActivity.has(42)).toBeFalse();
    expect(jest.getTimerCount()).toBe(initialTimers);

    for (let index: number = 0; index < BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      expect(shouldPassBotMessage(message(42, true, OTHER_CHAT_ID), OWN_BOT_ID)).toBeTrue();
    }
    expect(shouldPassBotMessage(message(42, true, OTHER_CHAT_ID), OWN_BOT_ID)).toBeFalse();
    // 别的群用满额度后，本群的删除目标发言仍放行，交给删除 ingress。
    expect(shouldPassBotMessage(message(42), OWN_BOT_ID)).toBeTrue();
  });

  test("每条发言续 90 分钟，到期清空计数并允许重新发言", () => {
    const incoming: Message = message(42);
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    jest.advanceTimersByTime(BOT_MESSAGE_ACTIVITY_TTL_MS - 1);
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    jest.advanceTimersByTime(1);
    expect(botMessageActivity.get(42)?.count).toBe(2);
    jest.advanceTimersByTime(BOT_MESSAGE_ACTIVITY_TTL_MS - 1);
    expect(botMessageActivity.has(42)).toBeFalse();
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    expect(botMessageActivity.get(42)?.count).toBe(1);
  });

  test("超额发言仍刷新过期时间，停止发言满 90 分钟后重新放行", () => {
    const incoming: Message = message(42);
    for (let index: number = 0; index < BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      shouldPassBotMessage(incoming, OWN_BOT_ID);
    }
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
    jest.advanceTimersByTime(BOT_MESSAGE_ACTIVITY_TTL_MS - 1);
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
    jest.advanceTimersByTime(1);
    expect(botMessageActivity.has(42)).toBeTrue();
    jest.advanceTimersByTime(BOT_MESSAGE_ACTIVITY_TTL_MS - 1);
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
  });

  test("连续发言复用同一 timer，活跃计时器数不随消息数增长", () => {
    const incoming: Message = message(42);
    const initialTimers: number = jest.getTimerCount();
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    const timer: ReturnType<typeof setTimeout> | null | undefined = botMessageActivity.get(42)?.timer;
    for (let index: number = 0; index < 20_000; index += 1) {
      shouldPassBotMessage(incoming, OWN_BOT_ID);
    }
    expect(botMessageActivity.get(42)?.timer).toBe(timer);
    expect(botMessageActivity.get(42)?.count).toBe(BOT_MESSAGE_ACTIVITY_LIMIT + 1);
    expect(jest.getTimerCount()).toBe(initialTimers + 1);
  });

  test("计时器未触发但时钟已过期时惰性清除：撤掉旧计时器、重新计数并放行 15 条", () => {
    const incoming: Message = message(42);
    const initialTimers: number = jest.getTimerCount();
    for (let index: number = 0; index <= BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      shouldPassBotMessage(incoming, OWN_BOT_ID);
    }
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
    const expired: ReturnType<typeof setTimeout> | null | undefined = botMessageActivity.get(42)?.timer;
    jest.setSystemTime(Date.now() + BOT_MESSAGE_ACTIVITY_TTL_MS);
    expect(botMessageActivity.has(42)).toBeTrue();
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    expect(botMessageActivity.get(42)?.count).toBe(1);
    expect(botMessageActivity.get(42)?.timer).not.toBe(expired);
    expect(jest.getTimerCount()).toBe(initialTimers + 1);
    for (let index: number = 1; index < BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
      expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeTrue();
    }
    expect(shouldPassBotMessage(incoming, OWN_BOT_ID)).toBeFalse();
  });

  test("512 条容量满时拒绝新 bot，现有记录仍按次数闸处理", () => {
    const initialTimers: number = jest.getTimerCount();
    for (let id: number = 1; id <= BOT_MESSAGE_ACTIVITY_MAX_ENTRIES; id += 1) {
      expect(shouldPassBotMessage(message(id), OWN_BOT_ID)).toBeTrue();
    }
    expect(botMessageActivity.size).toBe(BOT_MESSAGE_ACTIVITY_MAX_ENTRIES);
    expect(jest.getTimerCount()).toBe(initialTimers + BOT_MESSAGE_ACTIVITY_MAX_ENTRIES);
    expect(shouldPassBotMessage(message(OWN_BOT_ID), OWN_BOT_ID)).toBeTrue();
    expect(botMessageActivity.has(OWN_BOT_ID)).toBeFalse();
    expect(jest.getTimerCount()).toBe(initialTimers + BOT_MESSAGE_ACTIVITY_MAX_ENTRIES);
    expect(shouldPassBotMessage(message(BOT_MESSAGE_ACTIVITY_MAX_ENTRIES + 1), OWN_BOT_ID)).toBeFalse();
    expect(botMessageActivity.has(BOT_MESSAGE_ACTIVITY_MAX_ENTRIES + 1)).toBeFalse();
    expect(jest.getTimerCount()).toBe(initialTimers + BOT_MESSAGE_ACTIVITY_MAX_ENTRIES);
    expect(shouldPassBotMessage(message(1), OWN_BOT_ID)).toBeTrue();
    expect(botMessageActivity.get(1)?.count).toBe(2);
    expect(jest.getTimerCount()).toBe(initialTimers + BOT_MESSAGE_ACTIVITY_MAX_ENTRIES);
    jest.advanceTimersByTime(BOT_MESSAGE_ACTIVITY_TTL_MS);
    expect(botMessageActivity.size).toBe(0);
    expect(jest.getTimerCount()).toBe(initialTimers);
    expect(shouldPassBotMessage(message(BOT_MESSAGE_ACTIVITY_MAX_ENTRIES + 1), OWN_BOT_ID)).toBeTrue();
  });
});
