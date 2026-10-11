/**
 * 按次回复工具集（`createReplyToolset`）用例文件共用的 Telegram 出站与停顿替身、逐用例复位。
 *
 * 形态照 `test/helpers/autoMessageMocks.ts`：import 期登记 `mock.module`，必须在被测
 * 生产模块之前 import；各用例文件用顶层 `await import` 拿生产模块，天然满足。Telegram
 * 模块保留真实导出，只替换本组用例观察的出站调用；`libs/sleep` 整体替换为立即完成的替身，
 * 动作节奏与快速补字的停顿只留下调用记录。
 */

import { mock } from "bun:test";
import * as realTelegram from "../../packages/infra/telegram";
import type { TelegramSendResult } from "../../packages/types/telegram";

/** 文字与贴纸替身共用的下一条消息 ID；每个用例开始时复位，按发送顺序递增。 */
const nextMessageId: { current: number } = { current: 100 };

async function sendMessageStub(params: { replyToMessageId?: number }): Promise<TelegramSendResult | undefined> {
  return { messageId: nextMessageId.current++, repliedToMessageId: params.replyToMessageId };
}
export const sendMessageMock = mock(sendMessageStub);
export const deleteMessageMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
async function setMessageReactionStub(..._args: unknown[]): Promise<boolean> {
  return true;
}
export const setMessageReactionMock = mock(setMessageReactionStub);
export const sendStickerMock = mock(
  async (..._args: unknown[]): Promise<number | undefined> => nextMessageId.current++
);
async function sleepStub(..._args: unknown[]): Promise<void> {}
export const sleepMock = mock(sleepStub);

mock.module("../../packages/infra/telegram", () => ({
  ...realTelegram,
  telegramApi: { getStickerSet: mock(async (): Promise<null> => null) },
  sendMessageWithResult: sendMessageMock,
  deleteMessage: deleteMessageMock,
  setMessageReaction: setMessageReactionMock,
  sendChooseStickerAction: mock(async (): Promise<boolean> => true),
  sendTypingAction: mock(async (): Promise<boolean> => true),
  sendUploadPhotoAction: mock(async (): Promise<boolean> => true),
  sendSticker: sendStickerMock,
}));

mock.module("../../packages/libs/sleep", () => ({
  sleep: sleepMock,
}));

/**
 * 各用例文件的 beforeEach：复位消息 ID、清空调用记录；有用例排 *Once 的替身用 mockReset
 * 连同没消费完的 Once 一起清掉，再装回默认实现。
 */
export function resetReplyToolsetMocks(): void {
  nextMessageId.current = 100;
  sendMessageMock.mockReset();
  sendMessageMock.mockImplementation(sendMessageStub);
  deleteMessageMock.mockClear();
  setMessageReactionMock.mockReset();
  setMessageReactionMock.mockImplementation(setMessageReactionStub);
  sendStickerMock.mockClear();
  sleepMock.mockReset();
  sleepMock.mockImplementation(sleepStub);
}
