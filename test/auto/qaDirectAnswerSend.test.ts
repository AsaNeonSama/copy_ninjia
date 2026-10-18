import { beforeEach, describe, expect, mock, test } from "bun:test";
import { replyCommandNoticeVia } from "../helpers/common";

/**
 * 问答直答的发送边界（判定在 qaDirectAnswer.test.ts）：
 * 1. 答案走 sendMessage，不走命令提示的延迟清理边界；
 * 2. 论坛群里带上话题 ID。
 */

interface CapturedSend {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly messageThreadId?: number;
}

const sends: CapturedSend[] = [];
const sendCommandMessage = mock((): Promise<undefined> => Promise.resolve(undefined));

mock.module("../../packages/infra/telegram", () => ({
  sendMessage: (params: CapturedSend): Promise<number> => {
    sends.push(params);
    return Promise.resolve(4242);
  },
  sendCommandMessage,
  replyCommandNotice: replyCommandNoticeVia(sendCommandMessage),
}));

const { sendQaDirectAnswer } = await import("../../packages/auto/message/qaDirectAnswer");

beforeEach((): void => {
  sends.length = 0;
  sendCommandMessage.mockClear();
});

describe("群问答直答的发送边界", () => {
  test("答案走 sendMessage，不进命令的 30 秒清理边界", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: undefined,
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe("点置顶那条链接");
    expect(sends[0]?.replyToMessageId).toBe(7);
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("论坛话题里的提问，答案带着话题发回去", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: 55,
    });

    expect(sends[0]?.messageThreadId).toBe(55);
  });

  test("General 与非论坛群不设置话题参数", async () => {
    await sendQaDirectAnswer({
      chatId: -1001,
      replyToMessageId: 7,
      answer: "点置顶那条链接",
      messageThreadId: undefined,
    });

    expect(sends[0]?.messageThreadId).toBeUndefined();
  });
});
