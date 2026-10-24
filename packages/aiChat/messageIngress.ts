import {
  aiMemoryRevisionCounters,
  latestAiMemories,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
  pendingAiMemoryTeardowns,
} from "../cache/main/aiChat";
import type {
  AiRecordBotImageMessage,
  AiRecordMediaMessage,
  AiRecordMessage,
  AiTriggerMessage,
} from "../types/aiChat/protocol";
import {
  AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER,
  AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER,
} from "../consts/aiChat/provider";
import { chatQaEntries, chatQaTriggerJson } from "../cache/main/qa";
import { telegramOutboundGateState } from "../cache/main/telegram";
import type { TelegramRetryLane } from "../types/telegramOutbound";
import { postAiChatOrThrow } from "./workerBridge";

/**
 * 为 purge 后的首份新记忆武装即时持久化标志，并向 AI Worker 投递记录消息；投递失败时回滚新武装的标志。
 * @param message 待投递给 AI Worker 的上下文记录消息。
 */
function postMemoryRecord(message: AiRecordMessage | AiRecordMediaMessage | AiRecordBotImageMessage): void {
  const armedRevision: number | null | undefined =
    postPurgeAiMemoryPersistRevisions.get(message.chatId);
  const shouldArm: boolean = armedRevision === undefined &&
    !latestAiMemories.has(message.chatId) &&
    aiMemoryRevisionCounters.has(message.chatId);
  if (shouldArm) postPurgeAiMemoryPersistRevisions.set(message.chatId, null);
  try {
    if (shouldArm || armedRevision === null) message.persistImmediately = true;
    postAiChatOrThrow(message);
    if (shouldArm) pendingAiMemoryTeardowns.delete(message.chatId);
  } catch (error: unknown) {
    if (shouldArm) postPurgeAiMemoryPersistRevisions.delete(message.chatId);
    throw error;
  }
}

/**
 * 判定 Telegram message 发送车道是否处于 AI 回复软背压状态（见 docs/cn/04-invariants.md）。
 * @returns 并发在途数或排队重试数达到高水位时返回 `true`，否则返回 `false`。
 */
function isTelegramReplyBackpressured(): boolean {
  const messageLane: TelegramRetryLane = telegramOutboundGateState.lanes.message;
  return messageLane.activeCount >= AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER ||
    messageLane.pendingCount >= AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER;
}

/**
 * 向 AI Worker 投递一条文字或机器人图片上下文记录。
 * 调用方必须传入独占的新构造载荷对象，本函数会原地改写 `persistImmediately`。
 * @param message 独占的新构造文字或机器人图片记录消息载荷。
 */
export function recordChatMessage(message: AiRecordMessage | AiRecordBotImageMessage): void {
  purgedAiMemoryChats.delete(message.chatId);
  postMemoryRecord(message);
}

/**
 * 向 AI Worker 投递一条媒体消息记录；若该消息同时发起回复，原地写入当前 Telegram 发送面软背压快照。
 * @param message 独占的新构造媒体消息记录载荷。
 */
export function recordChatMedia(message: AiRecordMediaMessage): void {
  purgedAiMemoryChats.delete(message.chatId);
  if (message.replyTelegramBackpressured !== undefined) {
    message.replyTelegramBackpressured = isTelegramReplyBackpressured();
  }
  postMemoryRecord(message);
}

/** 触发一次回复所需的主线程载荷；随机触发默认关闭，发送面高压与本群问答由本模块补齐。 */
export type GenerateAndSendReplyParams = Omit<
  AiTriggerMessage,
  "type" | "isRandomTrigger" | "telegramBackpressured" | "chatQaJson" | "chatQaCount"
> & {
  isRandomTrigger?: boolean;
};

/**
 * 获取或生成本群问答的缓存 JSON 字符串；本群无问答时返回 undefined。
 * @param chatId 群聊 ID。
 * @param entries 本群当前的问答词条映射。
 * @returns 序列化后的问答词条 JSON 字符串；`entries` 未定义时返回 `undefined`。
 */
function chatQaJsonFor(chatId: number, entries: ReadonlyMap<string, string> | undefined): string | undefined {
  if (entries === undefined) return undefined;
  let json: string | undefined = chatQaTriggerJson.get(chatId);
  if (json === undefined) {
    json = JSON.stringify([...entries]);
    chatQaTriggerJson.set(chatId, json);
  }
  return json;
}

/**
 * 向 AI Worker 投递一次回复触发消息。
 * @param params 回复触发参数，包含群聊 ID、触发者、目标回复消息、生图意图与论坛话题。
 */
export function generateAndSendReply({
  chatId,
  triggerSenderId,
  replyToMessageId,
  imageGenerationRequested,
  imageGenerationReference,
  isRandomTrigger = false,
  messageThreadId,
}: GenerateAndSendReplyParams): void {
  const chatQa: ReadonlyMap<string, string> | undefined = chatQaEntries.get(chatId);
  postAiChatOrThrow({
    type: "trigger",
    chatId,
    triggerSenderId,
    replyToMessageId,
    isRandomTrigger,
    telegramBackpressured: isTelegramReplyBackpressured(),
    imageGenerationRequested,
    imageGenerationReference,
    chatQaJson: chatQaJsonFor(chatId, chatQa),
    chatQaCount: chatQa === undefined ? 0 : chatQa.size,
    messageThreadId,
  });
}
