import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import { bot } from "./mainClient";
import { downloadTelegramFileBytes } from "./fileDownload";
import { sendTemporaryMessageOnMain } from "./temporaryMessage";
import {
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_FILE_METADATA_TIMEOUT_MS,
  MEDIA_MAX_DOWNLOAD_BYTES,
} from "../../consts/aiChat/media";
import { VOICE_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/voice";
import type {
  TelegramSentMessage,
  TelegramSentPhotoMessage,
  TelegramWorkerDownloadFileResult,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
} from "../../types/telegramWorker";
import { isTelegramMessageRequest } from "./outboundRetryPolicy";
import { telegramSignal } from "../../libs/telegramSignal";
import { pickPhotoSize } from "../../libs/telegramImage";
import { beginSelfSentSend, endSelfSentSend, markSelfSent } from "../selfSentTracker";

/** grammY raw API 的单方法调用形态；raw 是按方法名转发到 callApi 的 Proxy，经过同一组出站 transformer。 */
type TelegramRawCall = (
  payload: TelegramWorkerJsonCall["payload"],
  signal?: ReturnType<typeof telegramSignal>
) => Promise<unknown>;

/**
 * 按方法名调用 raw API；方法白名单已由 aiAllows / antiRaidAllows 判过，payload 形态由 TelegramWorkerJsonCall 约束。
 * @param call JSON 方法名与参数载荷。
 * @param signal 请求取消信号。
 * @returns grammY raw API 的原始返回值。
 */
function executeJsonCall(
  call: TelegramWorkerJsonCall,
  signal: AbortSignal
): Promise<unknown> {
  const rawCall: TelegramRawCall = bot.api.raw[call.method] as TelegramRawCall;
  return rawCall(call.payload, telegramSignal(signal));
}

/**
 * 按 Worker 下载请求的用途选择字节上限并执行主线程文件下载。
 * @param request Worker 文件下载请求。
 * @param signal 请求取消信号。
 * @returns 文件下载结果。
 */
function downloadTelegramFile(
  request: Extract<TelegramWorkerRequest, { operation: "downloadFile" }>,
  signal: AbortSignal
): Promise<TelegramWorkerDownloadFileResult> {
  return downloadTelegramFileBytes({
    fileId: request.fileId,
    maxBytes: request.purpose === "vision" ? MEDIA_MAX_DOWNLOAD_BYTES : VOICE_MAX_DOWNLOAD_BYTES,
    metadataTimeoutMs: MEDIA_FILE_METADATA_TIMEOUT_MS,
    downloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
    signal,
  });
}

/**
 * 把 Worker 经本边界发出的消息登记进主线程的自发消息表。
 *
 * `infra/selfSentTracker.ts` 按线程隔离：Worker 侧的 `sendMessage` 在自己的 isolate 里
 * `markSelfSent`；真正的 Bot API 调用中，`call`（`bot.api.raw.*`）、`sendPhoto` 与 `sendVoice`
 * 直接调用 `bot.api`，不经主线程共享动作层的登记，由本函数在主线程统一补登记（`sendTemporaryMessage`
 * 委托 `sendTemporaryMessageOnMain`，其内部经主线程 `sendMessage` 已登记，此处因返回回执而非原始 `Message`
 * 为安全 no-op）。主线程据此在频道帖回投时识别自发消息（三个入口的判定见
 * auto/message/index.ts、commands/cjkAction.ts、commands/qa/ingress.ts）。
 *
 * 登记发生在响应回传给 Worker 之前。两个 Worker 都不回投「我发了什么」，本函数是
 * 全部 Worker 自发消息的唯一登记点。
 *
 * 登记时刻是发送响应落地，回投可能由并发的长轮询先取回；入口侧因此在同步的
 * `isBotOwnMessage` 之外走有界 rendezvous，见 docs/cn/04-invariants.md 的
 * 「出站请求与消息安全」。
 *
 * 判据取返回值的形状而不是按方法名 switch：只要产出 Message 就被覆盖。读结果里恒为
 * 数字的 `chat.id`，不读 payload 的 `chat_id`（可以是 `@username` 字符串）；只返回
 * `MessageId` 的 `copyMessage` 不在任何 Worker 能力白名单里。
 * @param result Bot API 调用返回的原始结果。
 */
function markWorkerSentMessage(result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  if (!("message_id" in result) || !("chat" in result)) return;
  const messageId: unknown = result.message_id;
  const chat: unknown = result.chat;
  if (typeof messageId !== "number") return;
  if (typeof chat !== "object" || chat === null || !("id" in chat)) return;
  const chatId: unknown = chat.id;
  if (typeof chatId !== "number") return;
  markSelfSent(chatId, messageId);
}

/**
 * 回复关系只保留被回复消息的 id；没有回复关系时为 undefined。
 * @param sent Telegram 返回的完整已发送消息。
 * @returns 仅含被回复消息 ID 的对象；无回复关系时返回 undefined。
 */
function repliedToReceipt(sent: Message): TelegramSentMessage["reply_to_message"] {
  const repliedTo: Message | undefined = sent.reply_to_message;
  return repliedTo === undefined ? undefined : { message_id: repliedTo.message_id };
}

/**
 * 发送回执投影：消息 id 与回复关系两个键固定写全。
 * @param sent Telegram 返回的完整已发送消息。
 * @returns 投影后的发送回执。
 */
function sentMessageReceipt(sent: Message): TelegramSentMessage {
  return { message_id: sent.message_id, reply_to_message: repliedToReceipt(sent) };
}

/**
 * 图片发送回执投影：在 sentMessageReceipt 的两个键之后只带 pickPhotoSize 选中的那一档。
 * @param sent Telegram 返回的图片消息。
 * @returns 含选中尺寸档位的图片发送回执。
 */
function sentPhotoReceipt(sent: Message.PhotoMessage): TelegramSentPhotoMessage {
  return {
    message_id: sent.message_id,
    reply_to_message: repliedToReceipt(sent),
    photo: [pickPhotoSize(sent.photo)],
  };
}

/**
 * JSON 方法的回执：sendMessage / sendSticker 投影成 TelegramSentMessage，其余原样返回。
 * @param call Worker 发起的 JSON 调用描述。
 * @param result 主线程执行得到的原始结果。
 * @returns 回传给 Worker 的投影或原始结果。
 */
function jsonCallReply(call: TelegramWorkerJsonCall, result: unknown): unknown {
  switch (call.method) {
    case "sendMessage":
    case "sendSticker":
      return sentMessageReceipt(result as Message);
    case "answerCallbackQuery":
    case "banChatMember":
    case "banChatSenderChat":
    case "deleteMessage":
    case "deleteMessages":
    case "getChat":
    case "getChatAdministrators":
    case "getChatMember":
    case "getStickerSet":
    case "restrictChatMember":
    case "sendChatAction":
    case "setChatPermissions":
    case "setMessageReaction":
    case "unbanChatMember":
      return result;
  }
}

/**
 * 回传给 Worker 的结果：发送类只留共享动作层读取的字段（TelegramSentMessage /
 * TelegramSentPhotoMessage），其余请求原样返回。Bot API 对这几种发送恒返回 Message，
 * 投影按该契约读取；必须在 markWorkerSentMessage 读过完整结果之后调用。
 * @param request Worker 发起的 Telegram 请求。
 * @param result 主线程执行得到的原始结果。
 * @returns 回传给 Worker 的结果载荷。
 */
function workerReply(request: TelegramWorkerRequest, result: unknown): unknown {
  switch (request.operation) {
    case "call":
      return jsonCallReply(request.call, result);
    case "sendPhoto":
      return sentPhotoReceipt(result as Message.PhotoMessage);
    case "sendVoice":
      return sentMessageReceipt(result as Message);
    case "downloadFile":
    case "sendTemporaryMessage":
      return result;
  }
}

/**
 * 按操作分派到具体的主线程实现；能力白名单已在调用方判过。
 * @param request Worker 发起的 Telegram 请求。
 * @param signal 请求取消信号。
 * @returns 主线程具体实现返回的原始结果。
 */
async function dispatchTelegramWorkerRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  switch (request.operation) {
    case "call":
      return executeJsonCall(request.call, signal);
    case "sendPhoto":
      return bot.api.sendPhoto(
        request.chatId,
        new InputFile(request.bytes, request.fileName),
        request.other,
        telegramSignal(signal)
      );
    case "sendVoice":
      return bot.api.sendVoice(
        request.chatId,
        new InputFile(request.bytes, request.fileName),
        request.other,
        telegramSignal(signal)
      );
    case "downloadFile":
      return downloadTelegramFile(request, signal);
    case "sendTemporaryMessage":
      return sendTemporaryMessageOnMain({
        chatId: request.chatId,
        text: request.text,
        messageThreadId: request.messageThreadId,
        replyToMessageId: request.replyToMessageId,
        signal,
      });
  }
}

/**
 * 产消息的 Worker 请求发往的数字 chat：上传、临时提示，以及 isTelegramMessageRequest 认定的 JSON 方法；
 * 其余请求不进入自发消息在途计数。
 * @param request Worker 发起的 Telegram 请求。
 * @returns 产生消息的数字聊天 ID；不产生消息或目标非数字 ID 时返回 undefined。
 */
function selfSentTargetChatId(request: TelegramWorkerRequest): number | undefined {
  let chatId: number | string | undefined;
  switch (request.operation) {
    case "call":
      if (!isTelegramMessageRequest(request.call.method) || !("chat_id" in request.call.payload)) return undefined;
      chatId = request.call.payload.chat_id;
      break;
    case "downloadFile":
      return undefined;
    default:
      chatId = request.chatId;
  }
  return typeof chatId === "number" ? chatId : undefined;
}

/**
 * 主线程执行已通过 Worker 能力白名单的 Telegram 请求。
 *
 * 所有 Worker 的 Telegram 请求都收在这一个漏斗里，自发消息登记因此也只此一处
 * （见 markWorkerSentMessage）；产消息的请求在同一处登记在途发送。先用完整结果登记
 * 自发消息，再经 workerReply 投影后回传。
 * @param request 已通过能力白名单的 Worker 请求。
 * @param signal 请求取消信号。
 * @returns 投影后回传给 Worker 的结果。
 */
async function executeTelegramWorkerRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  const selfSentChatId: number | undefined = selfSentTargetChatId(request);
  if (selfSentChatId !== undefined) beginSelfSentSend(selfSentChatId);
  try {
    const result: unknown = await dispatchTelegramWorkerRequest(request, signal);
    markWorkerSentMessage(result);
    return workerReply(request, result);
  } finally {
    if (selfSentChatId !== undefined) endSelfSentSend(selfSentChatId);
  }
}

/**
 * 判断请求是否在 AI Worker 的 Telegram 能力白名单内。
 * @param request 待校验的 Worker 请求。
 * @returns 允许执行时返回 true，否则返回 false。
 */
function aiAllows(request: TelegramWorkerRequest): boolean {
  if (request.operation !== "call") {
    return (request.operation === "sendTemporaryMessage" && request.purpose === "notice") ||
      request.operation === "downloadFile" ||
      request.operation === "sendPhoto" ||
      request.operation === "sendVoice";
  }
  switch (request.call.method) {
    case "getStickerSet":
    case "sendChatAction":
    case "sendMessage":
    case "sendSticker":
    case "setMessageReaction":
      return true;
    default:
      return false;
  }
}

/**
 * 判断请求是否在 Anti-Raid Worker 的 Telegram 能力白名单内。
 * @param request 待校验的 Worker 请求。
 * @returns 允许执行时返回 true，否则返回 false。
 */
function antiRaidAllows(request: TelegramWorkerRequest): boolean {
  if (request.operation === "sendTemporaryMessage") return true;
  if (request.operation !== "call") return false;
  switch (request.call.method) {
    case "answerCallbackQuery":
    case "banChatMember":
    case "banChatSenderChat":
    case "deleteMessage":
    case "deleteMessages":
    case "getChat":
    case "getChatAdministrators":
    case "getChatMember":
    case "restrictChatMember":
    case "sendMessage":
    case "setChatPermissions":
    case "unbanChatMember":
      return true;
    default:
      return false;
  }
}

/**
 * AI Worker 只获得回复、媒体与贴纸所需的 Telegram 能力。
 * @param request AI Worker 发来的 Telegram 请求。
 * @param signal 请求取消信号。
 * @returns 主线程执行结果。
 */
export function handleAiWorkerTelegramRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!aiAllows(request)) {
    return Promise.reject(new Error("AI Worker requested an unsupported Telegram capability."));
  }
  return executeTelegramWorkerRequest(request, signal);
}

/**
 * Anti-Raid Worker 只获得验证、限权、清理与成员查询能力。
 * @param request Anti-Raid Worker 发来的 Telegram 请求。
 * @param signal 请求取消信号。
 * @returns 主线程执行结果。
 */
export function handleAntiRaidWorkerTelegramRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!antiRaidAllows(request)) {
    return Promise.reject(new Error("Anti-Raid Worker requested an unsupported Telegram capability."));
  }
  return executeTelegramWorkerRequest(request, signal);
}

/**
 * Telegram 下载成功回执把字节 buffer 直接转移给请求 Worker。主线程在能力处理器
 * 返回后不再读取该 Uint8Array。
 * @param request 对应的 Worker 请求。
 * @param value 准备回传给 Worker 的响应值。
 * @returns 需要零拷贝转移的 ArrayBuffer 列表；无需转移时返回 undefined。
 */
export function telegramWorkerResponseTransfer(
  request: TelegramWorkerRequest,
  value: unknown
): Bun.Transferable[] | undefined {
  if (
    request.operation !== "downloadFile" ||
    value === null ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("bytes" in value) ||
    !(value.bytes instanceof Uint8Array)
  ) return undefined;
  const buffer: ArrayBufferLike = value.bytes.buffer;
  return buffer instanceof ArrayBuffer ? [buffer] : undefined;
}
