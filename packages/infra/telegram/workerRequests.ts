import { InputFile } from "grammy";
import { bot } from "./mainClient";
import { downloadTelegramFileBytes } from "./fileDownload";
import type { SendTemporaryMessageOnMainParams } from "./temporaryMessage";
import {
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_FILE_METADATA_TIMEOUT_MS,
  MEDIA_MAX_DOWNLOAD_BYTES,
} from "../../consts/aiChat/media";
import { VOICE_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/voice";
import type {
  TelegramWorkerDownloadFileResult,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
  TelegramWorkerTemporaryMessageResult,
  TelegramWorkerTemporaryMessageSentResult,
} from "../../types/telegramWorker";
import { isTelegramMessageRequest } from "./outboundRetryPolicy";
import { telegramSignal } from "../../libs/telegramSignal";
import { beginSelfSentSend, endSelfSentSend, markSelfSent } from "../selfSentTracker";

async function sendTemporaryMessage(
  request: Extract<TelegramWorkerRequest, { operation: "sendTemporaryMessage" }>,
  signal: AbortSignal
): Promise<TelegramWorkerTemporaryMessageResult | undefined> {
  // 动态导入：组合能力依赖线程内 Telegram 动作层，只在执行时加载。
  const temporarySender: (
    params: SendTemporaryMessageOnMainParams
  ) => Promise<TelegramWorkerTemporaryMessageSentResult | undefined> =
    (await import("./temporaryMessage")).sendTemporaryMessageOnMain;
  return temporarySender({
    chatId: request.chatId,
    text: request.text,
    messageThreadId: request.messageThreadId,
    replyToMessageId: request.replyToMessageId,
    signal,
  });
}

/** grammY raw API 的单方法调用形态；raw 是按方法名转发到 callApi 的 Proxy，经过同一组出站 transformer。 */
type TelegramRawCall = (
  payload: TelegramWorkerJsonCall["payload"],
  signal?: ReturnType<typeof telegramSignal>
) => Promise<unknown>;

/** 按方法名调用 raw API；方法白名单已由 aiAllows / antiRaidAllows 判过，payload 形态由 TelegramWorkerJsonCall 约束。 */
function executeJsonCall(
  call: TelegramWorkerJsonCall,
  signal: AbortSignal
): Promise<unknown> {
  const rawCall: TelegramRawCall = bot.api.raw[call.method] as TelegramRawCall;
  return rawCall(call.payload, telegramSignal(signal));
}

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
 * `markSelfSent`，真正的 Bot API 调用是下面的 `bot.api.raw.*`，不经共享动作层的登记，
 * 由本函数在主线程补登记。主线程据此在频道帖回投时识别自发消息（三个入口的判定见
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

/** 按操作分派到具体的主线程实现；能力白名单已在调用方判过。 */
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
      return sendTemporaryMessage(request, signal);
  }
}

/**
 * 产消息的 Worker 请求发往的数字 chat：上传、临时提示，以及 isTelegramMessageRequest 认定的 JSON 方法；
 * 其余请求不进入自发消息在途计数。
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
 * （见 markWorkerSentMessage）；产消息的请求在同一处登记在途发送。
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
    return result;
  } finally {
    if (selfSentChatId !== undefined) endSelfSentSend(selfSentChatId);
  }
}

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

/** AI Worker 只获得回复、媒体与贴纸所需的 Telegram 能力。 */
export function handleAiWorkerTelegramRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!aiAllows(request)) {
    return Promise.reject(new Error("AI Worker requested an unsupported Telegram capability."));
  }
  return executeTelegramWorkerRequest(request, signal);
}

/** Anti-Raid Worker 只获得验证、限权、清理与成员查询能力。 */
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
