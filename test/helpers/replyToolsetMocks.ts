/**
 * 按次回复工具集（`createReplyToolset`）测试共用的 Telegram 出站与 `sleep` 替身及逐用例复位。
 *
 * 模块加载期登记 `mock.module`（须在动态导入被测生产模块前导入）：Telegram 模块保留真实导出并仅替换
 * 出站动作，`libs/sleep` 替换为立即完成的记录替身。
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

/** 逐用例复位消息 ID 序号、调用记录与替身默认实现。 */
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
