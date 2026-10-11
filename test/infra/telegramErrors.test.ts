import { describe, expect, test } from "bun:test";
import { grammyApiError } from "../helpers/grammyError";
import type { ChatDepartureReason } from "../../packages/types/chatTeardown";
import {
  classifyChatAbsence,
  isTelegramRequestRejected,
  isTelegramRetryPreconditionChanged,
  telegramErrorDetails,
  TelegramRetryPreconditionChangedError,
} from "../../packages/infra/telegram/errors";

describe("Telegram 错误诊断字段", () => {
  test("主线程 GrammyError 形状取 error_code 与 description", () => {
    const error: Error = Object.assign(new Error("Bad Request"), {
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    expect(telegramErrorDetails(error)).toEqual({ errorCode: 400, description: "Bad Request: chat not found" });
  });

  test("Worker 双工重建的错误取 telegramErrorCode 与 telegramDescription", () => {
    const error: Error = Object.assign(new Error("Telegram request failed"), {
      telegramErrorCode: 403,
      telegramDescription: "Forbidden: bot was kicked",
    });
    expect(telegramErrorDetails(error)).toEqual({ errorCode: 403, description: "Forbidden: bot was kicked" });
  });

  test("字段类型不符、缺字段或不是 Error 时返回 undefined", () => {
    expect(telegramErrorDetails(new Error("plain"))).toBeUndefined();
    expect(telegramErrorDetails(Object.assign(new Error("x"), {
      telegramErrorCode: "403",
      telegramDescription: "Forbidden",
    }))).toBeUndefined();
    expect(telegramErrorDetails(Object.assign(new Error("x"), { telegramErrorCode: 403 }))).toBeUndefined();
    expect(telegramErrorDetails({ error_code: 400, description: "Bad Request" })).toBeUndefined();
    expect(telegramErrorDetails(undefined)).toBeUndefined();
  });
});

describe("破坏性重试的前置条件失效判定", () => {
  test("原始错误与经 Worker 线协议按 name 重建的错误都能识别", () => {
    expect(isTelegramRetryPreconditionChanged(new TelegramRetryPreconditionChangedError())).toBeTrue();
    const rebuilt: Error = new Error("Telegram destructive retry precondition changed.");
    rebuilt.name = "TelegramRetryPreconditionChangedError";
    expect(isTelegramRetryPreconditionChanged(rebuilt)).toBeTrue();
    expect(isTelegramRetryPreconditionChanged(new Error("other"))).toBeFalse();
    expect(isTelegramRetryPreconditionChanged({ name: "TelegramRetryPreconditionChangedError" })).toBeFalse();
  });
});

describe("Bot API 明确拒收判定", () => {
  test("4xx 与 429 视为拒收，两种错误形状都认", () => {
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      error_code: 400,
      description: "Bad Request: query is too old",
    }))).toBeTrue();
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      telegramErrorCode: 429,
      telegramDescription: "Too Many Requests: retry after 3",
    }))).toBeTrue();
  });

  test("5xx、网络失败与本地错误不视为拒收", () => {
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      error_code: 502,
      description: "Bad Gateway",
    }))).toBeFalse();
    expect(isTelegramRequestRejected(new Error("socket hang up"))).toBeFalse();
    expect(isTelegramRequestRejected(undefined)).toBeFalse();
  });
});

describe("getChat 失败归为群不可达的判定", () => {
  test.each([
    ["群已删除或不存在", grammyApiError(400, "Bad Request: chat not found"), "gone"],
    ["普通群升级后的旧 id", grammyApiError(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1002 }), "gone"],
    ["只有迁移参数也算群已不存在", grammyApiError(400, "Bad Request: something else", { migrate_to_chat_id: -1002 }), "gone"],
    ["被踢出普通群", grammyApiError(403, "Forbidden: bot was kicked from the group chat"), "departed"],
    ["被踢出超级群", grammyApiError(403, "Forbidden: bot was kicked from the supergroup chat"), "departed"],
    ["已不是超级群成员", grammyApiError(403, "Forbidden: bot is not a member of the supergroup chat"), "departed"],
    ["Worker 双工重建的 403", Object.assign(new Error("Telegram request failed"), {
      telegramErrorCode: 403,
      telegramDescription: "Forbidden: bot is not a member of the group chat",
    }), "departed"],
  ] as const)("%s", (_label: string, error: Error, expected: ChatDepartureReason) => {
    expect(classifyChatAbsence(error)).toBe(expected);
  });

  test.each([
    ["描述不匹配的 400", grammyApiError(400, "Bad Request: not enough rights")],
    ["描述不匹配的 403", grammyApiError(403, "Forbidden: bot was blocked by the user")],
    ["403 却是群不存在的描述", grammyApiError(403, "Forbidden: chat not found")],
    ["400 却是被踢的描述", grammyApiError(400, "Bad Request: bot was kicked from the group chat")],
    ["限流", grammyApiError(429, "Too Many Requests: retry after 5")],
    ["服务端错误", grammyApiError(500, "Internal Server Error")],
    ["迁移参数不是数字", grammyApiError(400, "Bad Request: something else", { migrate_to_chat_id: "x" })],
    ["网络错误", new TypeError("fetch failed")],
  ] as const)("%s 不下结论", (_label: string, error: Error) => {
    expect(classifyChatAbsence(error)).toBeNull();
  });
});
