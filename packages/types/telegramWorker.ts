import type { Api, RawApi } from "grammy";
import type { PhotoSize } from "grammy/types";
import type { TelegramFileDownloadResult } from "./telegram";

/** 指定 grammY RawApi 方法的 JSON payload。 */
export type TelegramRawPayload<M extends keyof RawApi> = Parameters<RawApi[M]>[0];

/** Worker 允许通过主线程调用的 JSON Telegram Bot API 方法。 */
export type TelegramWorkerJsonCall =
  | { readonly method: "answerCallbackQuery"; readonly payload: TelegramRawPayload<"answerCallbackQuery"> }
  | { readonly method: "banChatMember"; readonly payload: TelegramRawPayload<"banChatMember"> }
  | { readonly method: "banChatSenderChat"; readonly payload: TelegramRawPayload<"banChatSenderChat"> }
  | { readonly method: "deleteMessage"; readonly payload: TelegramRawPayload<"deleteMessage"> }
  | { readonly method: "deleteMessages"; readonly payload: TelegramRawPayload<"deleteMessages"> }
  | { readonly method: "getChat"; readonly payload: TelegramRawPayload<"getChat"> }
  | { readonly method: "getChatAdministrators"; readonly payload: TelegramRawPayload<"getChatAdministrators"> }
  | { readonly method: "getChatMember"; readonly payload: TelegramRawPayload<"getChatMember"> }
  | { readonly method: "getStickerSet"; readonly payload: TelegramRawPayload<"getStickerSet"> }
  | { readonly method: "restrictChatMember"; readonly payload: TelegramRawPayload<"restrictChatMember"> }
  | { readonly method: "sendChatAction"; readonly payload: TelegramRawPayload<"sendChatAction"> }
  | { readonly method: "sendMessage"; readonly payload: TelegramRawPayload<"sendMessage"> }
  | { readonly method: "sendSticker"; readonly payload: TelegramRawPayload<"sendSticker"> }
  | { readonly method: "setChatPermissions"; readonly payload: TelegramRawPayload<"setChatPermissions"> }
  | { readonly method: "setMessageReaction"; readonly payload: TelegramRawPayload<"setMessageReaction"> }
  | { readonly method: "unbanChatMember"; readonly payload: TelegramRawPayload<"unbanChatMember"> };

/** Worker 上传图片所需的可克隆载荷；主线程重新构造 grammY InputFile。 */
export interface TelegramWorkerSendPhotoRequest {
  readonly operation: "sendPhoto";
  readonly chatId: number | string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly other: Omit<TelegramRawPayload<"sendPhoto">, "chat_id" | "photo">;
}

/** Worker 上传语音消息所需的可克隆载荷；主线程重新构造 grammY InputFile。 */
export interface TelegramWorkerSendVoiceRequest {
  readonly operation: "sendVoice";
  readonly chatId: number | string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly other: Omit<TelegramRawPayload<"sendVoice">, "chat_id" | "voice">;
}

/** 主线程代 Worker 完成 getFile + Telegram 文件下载的两段式请求。 */
export interface TelegramWorkerDownloadFileRequest {
  readonly operation: "downloadFile";
  readonly fileId: string;
  readonly purpose: "vision" | "voice";
}

/**
 * Worker 请求主线程发送一条固定期限的群提示。发送成功与登记延迟删除由主线程
 * 同步完成，删除期限统一为 COMMAND_MESSAGE_AUTO_DELETE_MS（infra/telegram/temporaryMessage.ts）。
 */
interface TelegramWorkerTemporaryMessageBase {
  readonly operation: "sendTemporaryMessage";
  readonly chatId: number;
  readonly messageThreadId?: number;
  readonly replyToMessageId?: number;
  readonly text: string;
}

/** 广告提示保留身份复查，其余群提示仅请求发送与清理。 */
export type TelegramWorkerTemporaryMessageRequest = TelegramWorkerTemporaryMessageBase & (
  | { readonly purpose: "adWarning"; readonly identityId: number }
  | { readonly purpose: "notice" }
);

/** 临时群提示已经发送且被主线程删除 owner 认领后的回执。 */
export interface TelegramWorkerTemporaryMessageSentResult {
  readonly messageId: number;
  /** 主线程收到 Telegram 成功响应的墙钟时刻。 */
  readonly sentAt: number;
}

/** 主线程发现目标当前拥有广告检测豁免，未向 Telegram 发出提示。 */
export interface TelegramWorkerTemporaryMessageSuppressedResult {
  readonly suppressed: true;
}

/** 引用广告警告请求的结算结果；undefined 仍表示实际发送失败。 */
export type TelegramWorkerTemporaryMessageResult =
  | TelegramWorkerTemporaryMessageSentResult
  | TelegramWorkerTemporaryMessageSuppressedResult;

/** 主线程代 Worker 下载的结局，与主线程自己的下载同一形态。 */
export type TelegramWorkerDownloadFileResult = TelegramFileDownloadResult;

/**
 * Worker 与主线程共用的内存上传描述；不携带 grammY 运行时对象。
 * Worker 代理会把 bytes.buffer 直接转移给主线程，调用 sendPhoto/sendVoice 后
 * 原 Uint8Array 已失效，调用方不得读取或复用。
 */
export interface TelegramMemoryFile {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

/**
 * 发送类方法的回执中，共享动作层（infra/telegram/actions/）唯一读取的字段：消息 id 与 Telegram
 * 实际建立的回复关系。主线程直接调用时拿到完整 Message（结构上满足本类型）；Worker 经
 * infra/telegram/workerRequests.ts 的主线程漏斗收到的是投影后的这几项，两个键固定写全。
 * 需要更多字段的发送（目标专属消息）只走主线程独占的 sendEphemeralMessage。
 */
export interface TelegramSentMessage {
  readonly message_id: number;
  readonly reply_to_message?: { readonly message_id: number };
}

/** 图片发送回执：另带 photo 档位；Worker 收到的只有按 libs/telegramImage.ts 的 pickPhotoSize 选中的那一档。 */
export interface TelegramSentPhotoMessage extends TelegramSentMessage {
  readonly photo: readonly PhotoSize[];
}

/** 删除目标专属临时消息所需的稳定参数。 */
export interface TelegramDeleteEphemeralMessageParams {
  /** 临时消息所在的群聊 ID 或频道用户名。 */
  readonly chatId: number | string;
  /** 专属临时消息的目标接收用户 ID。 */
  readonly receiverUserId: number;
  /** 待删除的专属临时消息 ID。 */
  readonly ephemeralMessageId: number;
}

/** Worker -> 主线程的 Telegram 能力请求。 */
export type TelegramWorkerRequest =
  | {
    readonly operation: "call";
    readonly call: TelegramWorkerJsonCall;
  }
  | TelegramWorkerSendPhotoRequest
  | TelegramWorkerSendVoiceRequest
  | TelegramWorkerDownloadFileRequest
  | TelegramWorkerTemporaryMessageRequest;

/**
 * Telegram 动作层实际需要的 Api 子集。主线程由 bot.api 实现，业务 Worker 由
 * 双工代理实现其中的 TelegramWorkerApi 子集；主线程独占方法不进入 Worker 协议。
 */
export type TelegramApi = Pick<Api,
  | "answerCallbackQuery"
  | "banChatMember"
  | "banChatSenderChat"
  | "copyMessage"
  | "deleteMessage"
  | "deleteMessages"
  | "editMessageText"
  | "getChat"
  | "getChatAdministrators"
  | "getChatMember"
  | "getStickerSet"
  | "restrictChatMember"
  | "sendChatAction"
  | "setChatPermissions"
  | "setMessageReaction"
  | "unbanChatMember"
  | "unbanChatSenderChat"
> & {
  deleteEphemeralMessage(
    params: TelegramDeleteEphemeralMessageParams,
    signal?: AbortSignal
  ): Promise<true>;
  /** 目标专属消息（ephemeral_message_parameters）；回执是完整 Message，仅主线程提供。 */
  sendEphemeralMessage(...args: Parameters<Api["sendMessage"]>): ReturnType<Api["sendMessage"]>;
  sendMessage(...args: Parameters<Api["sendMessage"]>): Promise<TelegramSentMessage>;
  sendSticker(...args: Parameters<Api["sendSticker"]>): Promise<TelegramSentMessage>;
  sendPhoto(
    chatId: Parameters<Api["sendPhoto"]>[0],
    photo: TelegramMemoryFile,
    other?: Parameters<Api["sendPhoto"]>[2],
    signal?: Parameters<Api["sendPhoto"]>[3]
  ): Promise<TelegramSentPhotoMessage>;
  sendVoice(
    chatId: Parameters<Api["sendVoice"]>[0],
    voice: TelegramMemoryFile,
    other?: Parameters<Api["sendVoice"]>[2],
    signal?: Parameters<Api["sendVoice"]>[3]
  ): Promise<TelegramSentMessage>;
};

/** 仅主线程提供的 Telegram 方法；不属于任何 Worker 的能力白名单。 */
export type TelegramMainOnlyMethod =
  | "copyMessage"
  | "deleteEphemeralMessage"
  | "editMessageText"
  | "sendEphemeralMessage"
  | "unbanChatSenderChat";

/** 业务 Worker 的代理接口，仅保留至少一个 owner 获准的能力。 */
export type TelegramWorkerApi = Readonly<Omit<TelegramApi, TelegramMainOnlyMethod>>;

/** 线程入口安装的真实主线程接口或 Worker 子集。 */
export type InstalledTelegramApi = TelegramApi | TelegramWorkerApi;
