import type { MessageId } from "grammy/types";
import type {
  TelegramPhotoSendResult,
  TelegramSendResult,
} from "../../../types/telegram";
import type {
  TelegramApi,
  TelegramSentMessage,
  TelegramSentPhotoMessage,
} from "../../../types/telegramWorker";
import { markSelfSent } from "../../selfSentTracker";
import { telegramApi } from "../client";
import {
  replyParametersFor,
  runTelegramAction,
} from "./core";
import { telegramSignal } from "../../../libs/telegramSignal";
import { pickPhotoFile } from "../../../libs/telegramImage";
import { toTelegramSendResult } from "./sendResult";

type SendStickerApi = Pick<TelegramApi, "sendSticker">;
type SendPhotoApi = Pick<TelegramApi, "sendPhoto">;
type SendVoiceApi = Pick<TelegramApi, "sendVoice">;

export interface SendStickerParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 贴纸的 Telegram file_id。 */
  fileId: string;
  /** 执行贴纸发送的 Telegram API 接口。 */
  api?: SendStickerApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /** 论坛群的话题标识；不传时 Telegram 将消息发送到 General。 */
  messageThreadId?: number;
}

/**
 * 发送贴纸消息并登记自发消息标识。
 * @param params 贴纸发送参数。
 * @returns 发送成功时返回 message_id，失败时返回 undefined。
 */
export async function sendSticker({
  chatId,
  fileId,
  api = telegramApi,
  signal,
  messageThreadId,
}: SendStickerParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: (
      requestSignal?: AbortSignal
    ): Promise<TelegramSentMessage> =>
      api.sendSticker(
        chatId,
        fileId,
        { message_thread_id: messageThreadId },
        telegramSignal(requestSignal)
      ),
    map: (sent: TelegramSentMessage): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    selfSentChatId: chatId,
  });
}

export interface SendPhotoParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** Worker 调用会转移底层 ArrayBuffer；函数返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  /** 图片的 MIME 类型（决定上传文件扩展名）。 */
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** 要回复的目标消息 ID。 */
  replyToMessageId?: number;
  /** 执行图片发送的 Telegram API 接口。 */
  api?: SendPhotoApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /** 图注须由调用方限制在 Telegram caption 长度上限内。 */
  caption?: string;
  /** 论坛群的话题标识；挂回复时也必须显式传递。 */
  messageThreadId?: number;
  /** 为 true 时以 Telegram 剧透遮罩发送（`has_spoiler`），点开才显示。 */
  hasSpoiler?: boolean;
}

/**
 * 从内存上传图片，登记自发消息并返回实际回复关系与这张图的视觉源。
 * @param params 图片发送参数。
 * @returns 发送成功时返回消息 ID、实际回复关系与选中的图片文件标识，失败时返回 undefined。
 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = telegramApi,
  signal,
  caption,
  messageThreadId,
  hasSpoiler = false,
}: SendPhotoParams): Promise<TelegramPhotoSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<TelegramSentPhotoMessage> => {
      const extension: string = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
      // 定形一次初始化，同 actions/messages.ts 的 sendMessageWithResult。
      const other: Parameters<SendPhotoApi["sendPhoto"]>[2] = {
        message_thread_id: messageThreadId,
        caption: caption ? caption : undefined,
        reply_parameters: replyParametersFor(replyToMessageId),
        has_spoiler: hasSpoiler ? true : undefined,
      };
      return api.sendPhoto(
        chatId,
        { bytes, fileName: `generated.${extension}` },
        other,
        telegramSignal(requestSignal)
      );
    },
    map: (sent: TelegramSentPhotoMessage): TelegramPhotoSendResult => {
      const result: TelegramSendResult = toTelegramSendResult(chatId, sent);
      return {
        messageId: result.messageId,
        repliedToMessageId: result.repliedToMessageId,
        photo: pickPhotoFile(sent.photo),
      };
    },
    fallback: undefined,
    signal,
    selfSentChatId: chatId,
  });
}

export interface SendVoiceParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** OGG/Opus 或 MP3 语音字节；Worker 调用会转移底层 ArrayBuffer，函数返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  /** 扩展名与容器一致的上传文件名（`.ogg` 或 `.mp3`）。 */
  fileName: string;
  /** 要回复的目标消息 ID。 */
  replyToMessageId?: number;
  /** 执行语音发送的 Telegram API 接口。 */
  api?: SendVoiceApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /** 整秒时长。 */
  duration?: number;
  /** 论坛群的话题标识；挂回复时也必须显式传递。 */
  messageThreadId?: number;
}

/**
 * 从内存上传语音消息，登记自发消息并返回实际回复关系。
 * @param params 语音发送参数。
 * @returns 发送成功时返回消息 ID 与实际回复关系，失败时返回 undefined。
 */
export async function sendVoiceWithResult({
  chatId,
  bytes,
  fileName,
  replyToMessageId,
  api = telegramApi,
  signal,
  duration,
  messageThreadId,
}: SendVoiceParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send voice",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<TelegramSentMessage> => {
      // 定形一次初始化，同 actions/messages.ts 的 sendMessageWithResult。
      const other: Parameters<SendVoiceApi["sendVoice"]>[2] = {
        message_thread_id: messageThreadId,
        duration,
        reply_parameters: replyParametersFor(replyToMessageId),
      };
      return api.sendVoice(
        chatId,
        { bytes, fileName },
        other,
        telegramSignal(requestSignal)
      );
    },
    map: (sent: TelegramSentMessage): TelegramSendResult | undefined =>
      toTelegramSendResult(chatId, sent),
    fallback: undefined,
    signal,
    selfSentChatId: chatId,
  });
}

export interface CopyMessageParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 源消息所在的聊天 ID。 */
  fromChatId: number;
  /** 源消息 ID。 */
  messageId: number;
  /** 论坛群的话题标识；不传时 Telegram 将消息发送到 General。 */
  messageThreadId?: number;
  /** 替换原图注的新文字（不带实体、不设 parse_mode）；不给则保留原图注。 */
  caption?: string;
  /** 新图注是否显示在媒体上方；只在给出 caption 时生效。 */
  showCaptionAboveMedia?: boolean;
  /** 复制视频时的起播时间（秒）。 */
  videoStartTimestamp?: number;
}

/**
 * 复制消息并登记其自发消息标识。
 * @param params 消息复制参数。
 * @returns 复制成功时返回新消息的 message_id，失败时返回 undefined。
 */
export async function copyMessage({
  chatId,
  fromChatId,
  messageId,
  messageThreadId,
  caption,
  showCaptionAboveMedia,
  videoStartTimestamp,
}: CopyMessageParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: (signal?: AbortSignal): Promise<MessageId> =>
      telegramApi.copyMessage(
        chatId,
        fromChatId,
        messageId,
        // 定形一次初始化，缺席用 undefined 表达；grammY 序列化时丢弃 undefined。
        {
          message_thread_id: messageThreadId,
          caption,
          show_caption_above_media: showCaptionAboveMedia,
          video_start_timestamp: videoStartTimestamp,
        },
        telegramSignal(signal)
      ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
    selfSentChatId: chatId,
  });
}
