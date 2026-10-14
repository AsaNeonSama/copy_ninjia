import { describeMedia } from "../../aiChat/ai/imageDescription";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { repliedBotImageBackfills } from "../../cache/workers/aiChat/botImages";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { dirtyMemoryChats } from "../../cache/workers/aiChat/memory";
import { cachedReplyGeneration, isCachedReplyGenerationCurrent } from "../../cache/workers/aiChat/replies";
import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { sanitizeInline, truncateInline } from "../../libs/text";
import type { BotImageOrigin, BufferedMessage, BufferedReplyReference, PendingBotImage } from "../../types/aiChat/memory";
import type { AiBotInfo, AiRecordBotImageMessage, RepliedBotImage } from "../../types/aiChat/protocol";
import type { TelegramVisionSource } from "../../types/media";
import { buildBufferedMessage } from "./bufferedMessage";
import { lookupBufferedMessage } from "./bufferedMessageIndex";
import { botImageText } from "./mediaText";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";
import { pushBufferedMessage } from "./rollingMemory";

/**
 * 机器人自发图片在滚动记忆中的占位与识图回填：
 * - 占位态：条目持有 pendingImage，正文仅含自录记号与图注。
 * - 内容态：pendingImage 为 undefined，正文含识图描述与图注。
 * 生图落地后立即识图回填；命令与定时任务发出的图片仅在被群消息回复时按需识图回填。
 */

/** 机器人图片的识图目标与热区条目的占位引用。 */
interface BotImageTarget {
  readonly chatId: number;
  readonly messageId: number;
  readonly fileId: string;
  readonly fileUniqueId: string;
  /** 识图启动时条目持有的 pendingImage 引用；仅在引用一致时原位回填。 */
  readonly pending: PendingBotImage | undefined;
}

/** 条目仍在热区且持有同一份占位状态时，将其更新为内容态并标记脏记忆。 */
function fillBotImage({ chatId, messageId, pending }: BotImageTarget, description: string): void {
  if (pending === undefined) return;
  const entry: BufferedMessage | undefined = lookupBufferedMessage(chatId, messageId);
  if (entry?.pendingImage !== pending) return;
  entry.text = botImageText(pending.origin, description, pending.caption);
  entry.pendingImage = undefined;
  dirtyMemoryChats.add(chatId);
}

/** 识别机器人图片并在当前回复代际有效时回填占位态条目、触发回调。 */
function describeBotImage(
  target: BotImageTarget,
  onDescribed: ((description: string) => void) | undefined
): Promise<void> {
  const { chatId, fileId, fileUniqueId }: BotImageTarget = target;
  const generation: number = cachedReplyGeneration(chatId);
  const task: Promise<void> = describeMedia({
    kind: "photo",
    fileId,
    fileUniqueId,
    voiceMime: undefined,
    signal: replyGenerationSignal(generation),
  }).then((description: string | null): void => {
    if (description === null || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    fillBotImage(target, description);
    onDescribed?.(description);
  });
  trackReplyGenerationTask(chatId, generation, task);
  return task;
}

/**
 * 记录命令与定时任务发出的图片（占位态，不立即识图）；
 * edited 为 true 时将热区内原条目重置为占位态。
 */
export function recordBotImage(msg: AiRecordBotImageMessage): void {
  const self: AiBotInfo | null = botInfoState.current;
  if (self === null) return;
  const caption: string = sanitizeInline(msg.caption);
  const text: string = botImageText("command", "", caption);
  if (msg.edited) {
    const entry: BufferedMessage | undefined = lookupBufferedMessage(msg.chatId, msg.messageId);
    if (entry?.id !== self.id) return;
    entry.text = text;
    entry.pendingImage = { origin: "command", caption };
    dirtyMemoryChats.add(msg.chatId);
    return;
  }
  const now: number = Date.now();
  const entry: BufferedMessage | null = buildBufferedMessage(
    buildSelfRecordMessage({ chatId: msg.chatId, self, messageId: msg.messageId, text }),
    text,
    now
  );
  if (entry === null) return;
  entry.pendingImage = { origin: "command", caption };
  pushBufferedMessage(msg.chatId, entry, now);
}

/** trackGeneratedImage 的入参。 */
export interface TrackGeneratedImageParams {
  chatId: number;
  /** 刚写入热区、带生图记号与提示词的自录条目。 */
  entry: BufferedMessage;
  origin: Exclude<BotImageOrigin, "command">;
  /** 随图发出的图注；没有图注为空串。 */
  caption: string;
  /** Telegram 为这张图返回的视觉源。 */
  photo: TelegramVisionSource;
}

/** 将生图自录条目标记为占位态并立即启动识图回填。 */
export function trackGeneratedImage({ chatId, entry, origin, caption, photo }: TrackGeneratedImageParams): void {
  const pending: PendingBotImage = { origin, caption: sanitizeInline(caption) };
  entry.pendingImage = pending;
  void describeBotImage(
    { chatId, messageId: entry.messageId, fileId: photo.fileId, fileUniqueId: photo.fileUniqueId, pending },
    undefined
  );
}

/** 从 repliedBotImageBackfills 移除已完成的任务，内层表为空时删除外层键。 */
function forgetRepliedBotImage(chatId: number, messageId: number, task: Promise<void>): void {
  const byMessage: Map<number, Promise<void>> | undefined = repliedBotImageBackfills.get(chatId);
  if (byMessage?.get(messageId) !== task) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) repliedBotImageBackfills.delete(chatId);
}

/**
 * 解析被回复的机器人图片并回填回复引用正文：目标条目已在热区且为内容态时直接复用，
 * 否则启动识图并登记到 repliedBotImageBackfills 供回复轮等待。
 */
export function resolveRepliedBotImage(chatId: number, entry: BufferedMessage, image: RepliedBotImage): void {
  const replyTo: BufferedReplyReference | undefined = entry.replyTo;
  if (replyTo === undefined) return;
  const target: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyTo.messageId);
  if (target !== undefined && target.pendingImage === undefined) {
    replyTo.text = truncateInline(target.text, REPLY_REFERENCE_MAX_CHARS);
    return;
  }
  const task: Promise<void> = describeBotImage(
    {
      chatId,
      messageId: replyTo.messageId,
      fileId: image.fileId,
      fileUniqueId: image.fileUniqueId,
      pending: target?.pendingImage,
    },
    (description: string): void => {
      const filled: BufferedMessage | undefined = lookupBufferedMessage(chatId, replyTo.messageId);
      replyTo.text = truncateInline(
        filled !== undefined && filled.pendingImage === undefined
          ? filled.text
          : botImageText("command", description, sanitizeInline(image.caption)),
        REPLY_REFERENCE_MAX_CHARS
      );
      dirtyMemoryChats.add(chatId);
    }
  );
  let byMessage: Map<number, Promise<void>> | undefined = repliedBotImageBackfills.get(chatId);
  if (byMessage === undefined) {
    byMessage = new Map<number, Promise<void>>();
    repliedBotImageBackfills.set(chatId, byMessage);
  }
  byMessage.set(entry.messageId, task);
  const forget = (): void => forgetRepliedBotImage(chatId, entry.messageId, task);
  void task.then(forget, forget);
}

/** 读取触发消息对应的在途机器人图片回填任务。 */
export function repliedBotImageBackfill(chatId: number, messageId: number): Promise<void> | undefined {
  return repliedBotImageBackfills.get(chatId)?.get(messageId);
}
