import { DISABLED_LINK_PREVIEW, MESSAGE_NOT_MODIFIED } from "../../../consts/telegram";
import { telegramSignal } from "../../../libs/telegramSignal";
import type {
  InlineKeyboardMarkup,
  LinkPreviewOptions,
  Message,
  MessageEntity,
} from "grammy/types";
import { telegramApi } from "../client";
import { telegramErrorDetails } from "../errors";
import {
  replyParametersFor,
  runBooleanTelegramAction,
  runTelegramAction,
} from "./core";
import type {
  TelegramChatAction,
  TelegramParseMode,
  TelegramSendResult,
} from "../../../types/telegram";
import type { TelegramApi, TelegramSentMessage } from "../../../types/telegramWorker";
import { toTelegramSendResult } from "./sendResult";

type SendMessageApi = Pick<TelegramApi, "sendMessage">;
type SendEphemeralMessageApi = Pick<TelegramApi, "sendEphemeralMessage">;
type EditMessageTextApi = Pick<TelegramApi, "editMessageText">;
type SendChatActionApi = Pick<TelegramApi, "sendChatAction">;
type AnswerCallbackQueryApi = Pick<TelegramApi, "answerCallbackQuery">;

/** 文本消息除正文格式以外的发送参数；正文格式由 SendMessageFormat 二选一给出。 */
export interface SendMessageBaseParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 消息文本内容。 */
  text: string;
  /** 要回复的目标消息 ID。 */
  replyToMessageId?: number;
  /** 执行文本发送的 Telegram API 接口。 */
  api?: SendMessageApi;
  /** 内联按钮键盘。 */
  keyboard?: InlineKeyboardMarkup;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /** 是否关闭 Telegram 为正文中第一个 URL 自动生成的预览卡片。 */
  disableLinkPreview?: boolean;
  /** 原样沿用的链接预览设置（复读、翻译照搬原消息的预览）；给出时优先于 disableLinkPreview。 */
  linkPreviewOptions?: LinkPreviewOptions;
  /**
   * 论坛（topics）群的目标话题 ID（不传则落入 General）：
   * 用户命令与交互触发的消息落在触发消息所在话题，主线程命令提示由 `commandMessages.ts` / `commandPhotos.ts`
   * 自动按当前 update 补齐，脱离 update 作用域的回执与长期保留消息由调用方显式传入；bot 主动公告与定时任务不传。
   */
  messageThreadId?: number;
  /** 消息 id 的同步登记点，语义见 SendEphemeralMessageParams.onSent。 */
  onSent?: (messageId: number) => void;
}

/**
 * 正文格式：调用方算好偏移的 `entities` 与 `parseMode` 二选一（Bot API 规定两者互斥）。
 * 都不给就是纯文本。
 */
export type SendMessageFormat =
  | {
    /** 由调用方自行算好偏移的富文本实体；空数组按未提供处理。 */
    entities?: readonly MessageEntity[];
    parseMode?: undefined;
  }
  | {
    entities?: undefined;
    /**
     * 正文按 MarkdownV2 解析；拼进正文的动态文字必须已经过 libs/telegramMarkdown.ts
     * 转义（见 docs/cn/04-invariants.md）。解析失败按普通发送失败处理，不降级成纯文本。
     */
    parseMode: TelegramParseMode;
  };

export type SendMessageParams = SendMessageBaseParams & SendMessageFormat;

/**
 * 发送文本消息并返回 Telegram 实际建立的回复关系。只有显式给出 parseMode 时才设置
 * parse_mode，否则正文按纯文本发出、富文本只由 entities 表达。
 * @param params 文本消息发送参数。
 * @returns 发送成功时返回消息 ID 与实际回复关系，失败时返回 undefined。
 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = telegramApi,
  keyboard,
  signal,
  entities,
  parseMode,
  disableLinkPreview,
  linkPreviewOptions,
  messageThreadId,
  onSent,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<TelegramSentMessage> => {
      // 定形一次初始化：字段齐、顺序固定，缺席用 undefined 表达；grammY 两条
      // 序列化路径都丢弃 undefined，请求体与不带该键逐字节相同
      // （对拍见 test/infra/telegramSendPayload.test.ts）。
      const other: Parameters<SendMessageApi["sendMessage"]>[2] = {
        message_thread_id: messageThreadId,
        reply_parameters: replyParametersFor(replyToMessageId),
        reply_markup: keyboard,
        entities: entities && entities.length > 0 ? [...entities] : undefined,
        parse_mode: parseMode,
        link_preview_options: linkPreviewOptions ?? (disableLinkPreview ? DISABLED_LINK_PREVIEW : undefined),
      };
      return api.sendMessage(
        chatId,
        text,
        other,
        telegramSignal(requestSignal)
      );
    },
    map: (
      sent: TelegramSentMessage
    ): TelegramSendResult | undefined => {
      const result: TelegramSendResult = toTelegramSendResult(chatId, sent);
      onSent?.(result.messageId);
      return result;
    },
    fallback: undefined,
    signal,
    selfSentChatId: chatId,
  });
}

/**
 * 发送文本消息，只返回 Telegram message_id。
 * @param params 文本消息发送参数。
 * @returns 发送成功时返回 message_id，失败时返回 undefined。
 */
export async function sendMessage(
  params: SendMessageParams
): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export interface SendEphemeralMessageParams {
  /** 目标群聊 ID。 */
  chatId: number;
  /** 仅可看见该专属消息的目标用户 ID。 */
  receiverUserId: number;
  /** 触发该专属消息的回调查询 ID。 */
  callbackQueryId?: string;
  /** 消息文本内容。 */
  text: string;
  /** 内联按钮键盘。 */
  keyboard: InlineKeyboardMarkup;
  /** 主线程独占的发送入口；回执要读 chat、receiver_user 与 ephemeral_message_id。 */
  api?: SendEphemeralMessageApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 论坛（topics）群里这条目标专属提示要亮在哪个话题；语义见 SendMessageParams
   * 的同名字段。gag 的发言入口靠它跟着被管教的人换话题（见 commands/gag/）。
   */
  messageThreadId?: number;
  /**
   * 消息 id 的同步登记点：拿到 id 时立即回调，早于 runTelegramAction
   * 在发送成功之后补做的 update 取消判定（见 actions/core.ts）。
   *
   * 调用方用它把 id 落进自己的状态，update 取消随后照常向上抛。
   * 回调必须同步且不抛：它跑在错误边界内部，抛出按发送失败处理。
   */
  onSent?: (messageId: number) => void;
}

/**
 * 使用 SDK 的 ephemeral_message_parameters 发送目标专属消息，只在主线程可用。
 * 响应身份校验后交给业务状态机定向删除。
 * @param params 目标专属消息发送参数。
 * @returns 发送并校验成功时返回 ephemeral_message_id，失败时返回 undefined。
 */
export async function sendEphemeralMessage({
  chatId,
  receiverUserId,
  callbackQueryId,
  text,
  keyboard,
  api = telegramApi,
  signal,
  messageThreadId,
  onSent,
}: SendEphemeralMessageParams): Promise<number | undefined> {
  const other: Parameters<SendEphemeralMessageApi["sendEphemeralMessage"]>[2] = {
    message_thread_id: messageThreadId,
    ephemeral_message_parameters: {
      receiver_user_id: receiverUserId,
      callback_query_id: callbackQueryId,
    },
    reply_markup: keyboard,
  };
  return runTelegramAction({
    action: "send ephemeral message",
    execute: (requestSignal?: AbortSignal): ReturnType<TelegramApi["sendEphemeralMessage"]> =>
      api.sendEphemeralMessage(
        chatId,
        text,
        other,
        telegramSignal(requestSignal)
      ),
    map: (sent: Message.TextMessage): number => {
      const ephemeralMessageId: number | undefined =
        sent.ephemeral_message_id;
      if (
        sent.message_id !== 0 ||
        sent.chat.id !== chatId ||
        sent.receiver_user?.id !== receiverUserId ||
        ephemeralMessageId === undefined ||
        !Number.isSafeInteger(ephemeralMessageId) ||
        ephemeralMessageId <= 0
      ) {
        throw new Error("Telegram returned an invalid ephemeral message identity.");
      }
      onSent?.(ephemeralMessageId);
      return ephemeralMessageId;
    },
    fallback: undefined,
    signal,
  });
}

export interface SendChatActionParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 要显示的状态；取值由 TelegramChatAction 单点定义。 */
  action: TelegramChatAction;
  /** 执行聊天状态发送的 Telegram API 接口。 */
  api?: SendChatActionApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 论坛（topics）群里这次状态要亮在哪个话题；语义见 SendMessageParams
   * 的同名字段。不传就亮在 General（见 libs/forumTopic.ts）。
   */
  messageThreadId?: number;
}

/**
 * 发一次聊天状态（「正在输入…」这类）。
 * @param params 聊天状态发送参数。
 * @returns 发送成功返回 true，失败返回 false。
 */
export async function sendChatAction({
  chatId,
  action,
  api = telegramApi,
  signal,
  messageThreadId,
}: SendChatActionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    `send ${action} action`,
    (requestSignal?: AbortSignal): Promise<true> =>
      api.sendChatAction(
        chatId,
        action,
        { message_thread_id: messageThreadId },
        telegramSignal(requestSignal)
      ),
    signal
  );
}

/**
 * 这次拒绝是否就是「内容本就相同」。
 * @param error 待判定的异常值。
 * @returns 错误描述包含 MESSAGE_NOT_MODIFIED 时返回 true，否则返回 false。
 */
export function isMessageNotModified(error: unknown): boolean {
  return telegramErrorDetails(error)?.description.includes(MESSAGE_NOT_MODIFIED) === true;
}

export interface EditMessageTextParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 要编辑的目标消息 ID。 */
  messageId: number;
  /** 替换后的新文本内容。 */
  text: string;
  /** 执行消息编辑的 Telegram API 接口。 */
  api?: EditMessageTextApi;
  /** 由调用方自行算好偏移的富文本实体，语义同 SendMessageFormat.entities。 */
  entities?: readonly MessageEntity[];
  /** 新的按钮；不传即清空原有按钮。 */
  keyboard?: InlineKeyboardMarkup;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
}

/**
 * 就地改写一条已发出的文本消息；富文本只由 entities 表达，不设置 parse_mode。
 *
 * @param params 消息文本编辑参数。
 * @returns 是否已让远端处于目标状态。内容本就相同时同样为 true。
 */
export async function editMessageText({
  chatId,
  messageId,
  text,
  api = telegramApi,
  entities,
  keyboard,
  signal,
}: EditMessageTextParams): Promise<boolean> {
  // 「内容本就相同」在 execute 内就地吞掉：既不记 API 错误，也对调用方报成功。
  // 其余失败原样抛给统一边界，停机 abort 由 runTelegramAction 缺省的
  // logUnlessAborted 判为不记错误。
  return runBooleanTelegramAction(
    "edit message text",
    async (requestSignal?: AbortSignal): Promise<true> => {
      try {
        await api.editMessageText(
          chatId,
          messageId,
          text,
          {
            entities: entities && entities.length > 0 ? [...entities] : undefined,
            reply_markup: keyboard ?? { inline_keyboard: [] },
          },
          telegramSignal(requestSignal)
        );
      } catch (error: unknown) {
        if (!isMessageNotModified(error)) throw error;
      }
      return true;
    },
    signal
  );
}

export interface AnswerCallbackQueryParams {
  /** 待应答的回调查询 ID。 */
  callbackQueryId: string;
  /** 提示文本内容。 */
  text?: string;
  /** 为 true 时以弹窗形式展示提示，否则显示顶部轻提示。 */
  showAlert?: boolean;
  /** 执行回调查询应答的 Telegram API 接口。 */
  api?: AnswerCallbackQueryApi;
}

/**
 * 应答一次内联按钮的 callback query。
 * @param params 回调查询应答参数。
 */
export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = telegramApi,
}: AnswerCallbackQueryParams): Promise<void> {
  return runTelegramAction({
    action: "answer callback query",
    execute: (signal?: AbortSignal): Promise<true> =>
      api.answerCallbackQuery(
        callbackQueryId,
        { text, show_alert: showAlert },
        telegramSignal(signal)
      ),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}
