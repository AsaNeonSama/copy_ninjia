import { composeMediaText, sanitizeInline } from "../../libs/text";
import { displaySpeakerName } from "../../aiChat/ai/utils/chatTranscript";
import { getCatalogEntry } from "../../aiChat/ai/stickers/catalog";
import { describeMedia } from "../../aiChat/ai/imageDescription";
import { dirtyMemoryChats } from "../../cache/workers/aiChat/memory";
import { cachedReplyGeneration, isCachedReplyGenerationCurrent } from "../../cache/workers/aiChat/replies";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiRecordMediaMessage, ImageGenerationReference, RepliedBotImage } from "../../types/aiChat/protocol";
import { fallbackTextFor, pendingPlaceholderFor, replyFallbackDescriptionFor, resolvedTagFor } from "./mediaText";
import { buildBufferedMessage } from "./bufferedMessage";
import { pushBufferedMessage } from "./rollingMemory";
import { generateAndSendReply } from "./replyPipeline";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";
import { replyReferenceForBufferedEntry } from "./bufferedMessageIndex";
import { resolveRepliedBotImage } from "./botImages";
import { observeImageReferenceAlbumPhoto } from "./imageReferenceAlbums";
import type { MediaCommentContext } from "../../types/aiChat/replies";
import type { StickerCatalogEntry } from "../../types/stickers/catalog";

/**
 * 直接触发的图片或贴纸返回短期生图参考源，其余情况返回 undefined。
 *
 * @param msg 入站媒体记录消息
 * @returns 可供本轮生图使用的参考图片源；非直接触发或非图片/贴纸时返回 undefined
 */
function imageGenerationReferenceFor(msg: AiRecordMediaMessage): ImageGenerationReference | undefined {
  if (msg.directTriggerReason === undefined || (msg.kind !== "photo" && msg.kind !== "sticker")) {
    return undefined;
  }
  return {
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    width: msg.width,
    height: msg.height,
    mediaGroupId: msg.mediaGroupId,
  };
}

/**
 * 媒体消息回复了机器人图片时启动识图回填。
 *
 * @param msg 入站媒体记录消息
 * @param entry 已构建的滚动记忆缓冲条目
 */
function resolveRepliedBotImageOf(msg: AiRecordMediaMessage, entry: BufferedMessage): void {
  const botImage: RepliedBotImage | undefined = msg.replyTo?.botImage;
  if (botImage !== undefined) resolveRepliedBotImage(msg.chatId, entry, botImage);
}

/**
 * 构造媒体评价触发上下文。
 *
 * @param msg 入站媒体记录消息
 * @param entry 对应的滚动记忆缓冲条目
 * @param description 已解析或兜底的媒体文本描述
 * @returns 供回复轮消费的媒体评价上下文
 */
function mediaCommentFor(msg: AiRecordMediaMessage, entry: BufferedMessage, description: string): MediaCommentContext {
  return {
    kind: msg.kind,
    senderId: entry.id,
    senderName: displaySpeakerName(entry),
    description,
    triggerText: entry.text,
    triggerReference: replyReferenceForBufferedEntry(msg.messageId, entry),
    directTriggerReason: msg.directTriggerReason,
    replyTo: msg.directTriggerReason === undefined ? undefined : entry.replyTo,
    forwardedFrom: entry.forwardedFrom,
  };
}

/**
 * 记录入站媒体并按需触发回复：贴纸目录命中时同步写入描述，其余媒体先写入占位并在后台识图后回填；
 * `replyTelegramBackpressured` 有值时同步进入回复准入。顺位、取消与有界容量约束见 docs/cn/04-invariants.md。
 *
 * @param msg 主线程下发的入站媒体记录消息
 */
export function recordChatMedia(msg: AiRecordMediaMessage): void {
  const sanitizedCaption: string = sanitizeInline(msg.caption);
  const imageGenerationReference: ImageGenerationReference | undefined = imageGenerationReferenceFor(msg);
  const telegramBackpressured: boolean | undefined = msg.replyTelegramBackpressured;
  const now: number = Date.now();
  observeImageReferenceAlbumPhoto(msg);

  if (msg.kind === "sticker") {
    const catalogEntry: StickerCatalogEntry | undefined = getCatalogEntry(msg.fileUniqueId);
    if (catalogEntry) {
      const entry: BufferedMessage = buildBufferedMessage(
        msg,
        composeMediaText(resolvedTagFor("sticker", catalogEntry.description), sanitizedCaption),
        now
      )!;
      pushBufferedMessage(msg.chatId, entry, now);
      resolveRepliedBotImageOf(msg, entry);
      if (telegramBackpressured !== undefined) {
        generateAndSendReply({
          chatId: msg.chatId,
          triggerSenderId: msg.senderId,
          replyToMessageId: msg.messageId,
          messageThreadId: msg.messageThreadId,
          isRandomTrigger: false,
          telegramBackpressured,
          imageGenerationRequested: msg.directTriggerReason !== undefined,
          imageGenerationReference,
          mediaComment: mediaCommentFor(msg, entry, catalogEntry.description),
          mediaPreparation: undefined,
        });
      }
      return;
    }
  }

  const generation: number = cachedReplyGeneration(msg.chatId);
  const signal: AbortSignal = replyGenerationSignal(generation);
  const entry: BufferedMessage = buildBufferedMessage(
    msg,
    composeMediaText(pendingPlaceholderFor(msg.kind), sanitizedCaption),
    now
  )!;
  pushBufferedMessage(msg.chatId, entry, now);
  resolveRepliedBotImageOf(msg, entry);
  const preparation: PromiseWithResolvers<MediaCommentContext | null> | undefined =
    telegramBackpressured !== undefined
      ? Promise.withResolvers<MediaCommentContext | null>()
      : undefined;
  if (preparation) {
    generateAndSendReply({
      chatId: msg.chatId,
      triggerSenderId: msg.senderId,
      replyToMessageId: msg.messageId,
      messageThreadId: msg.messageThreadId,
      isRandomTrigger: false,
      telegramBackpressured,
      imageGenerationRequested: msg.directTriggerReason !== undefined,
      imageGenerationReference,
      mediaComment: mediaCommentFor(msg, entry, ""),
      mediaPreparation: preparation.promise,
    });
  }
  const task: Promise<void> = describeMedia({
    kind: msg.kind,
    fileId: msg.fileId,
    fileUniqueId: msg.fileUniqueId,
    voiceMime: msg.voiceMime,
    signal,
  }).then((description: string | null): void => {
    if (!isCachedReplyGenerationCurrent(msg.chatId, generation)) return;
    entry.text = composeMediaText(description ? resolvedTagFor(msg.kind, description) : fallbackTextFor(msg.kind, msg), sanitizedCaption);
    dirtyMemoryChats.add(msg.chatId);
    if (preparation && (msg.directTriggerReason !== undefined || description)) {
      preparation.resolve(mediaCommentFor(msg, entry, description ?? replyFallbackDescriptionFor(msg)));
    }
  }).finally((): void => { preparation?.resolve(null); });
  trackReplyGenerationTask(msg.chatId, generation, task);
}
