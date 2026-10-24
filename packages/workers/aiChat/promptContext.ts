import type { BoundedDeque } from "../../libs/boundedDeque";
import {
  buildColdMemoryBlock,
  buildTieredVerbatimTranscript,
  formatSpeakerIdentity,
} from "../../aiChat/ai/utils/chatTranscript";
import {
  MAX_SUMMARY_ROUNDS,
  VERBATIM_CONTEXT_MAX,
} from "../../consts/aiChat/memory";
import {
  directInvokerSentence,
  REPLY_CONTEXT_SECTION_NAMES,
  REPLY_CONTEXT_SECTION_TEXT,
} from "../../consts/aiChat/prompts/memory";
import {
  DIRECT_TRIGGER_INSTRUCTION,
  forwardedMediaNotice,
  mediaCommentInstruction,
  mediaMentionTriggerInstruction,
  mediaReplyTriggerInstruction,
  QUEUED_TRIGGER_FALLBACK_SENDER_NAME,
  queuedTriggerDescription,
  queuedTriggerInstruction,
  RANDOM_TRIGGER_INSTRUCTION,
  selfIdentityStatement,
} from "../../consts/aiChat/prompts/replyTask";
import { forwardPathTemplate } from "../../consts/aiChat/prompts/transcript";
import { TYPO_REQUIRED_INSTRUCTION } from "../../consts/aiChat/prompts/tools";
import { chatBuffers, chatSummaries } from "../../cache/workers/aiChat/memory";
import { lookupBufferedMessage } from "./bufferedMessageIndex";
import { resolvedTagFor } from "./mediaText";
import type { RenderedTranscript } from "../../aiChat/ai/utils/chatTranscript";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type {
  MediaCommentContext,
  QueuedReplyTrigger,
  ReplyPromptSections,
} from "../../types/aiChat/replies";
import type { MediaKind } from "../../types/media";

/**
 * 生成提示词中展示的媒体标签示例。
 *
 * @param kind 媒体类型
 * @returns 形如 `[图片：…]` 的媒体标签示例文本
 */
function mediaTagHintFor(kind: MediaKind): string {
  return resolvedTagFor(kind, "…");
}

/**
 * 格式化转发路径（「原始来源 → 当前群发送者」）。
 *
 * @param origin 原始转发来源描述；非转发消息为 undefined
 * @param senderId 当前群转发者的 Telegram ID
 * @param senderName 当前群转发者的显示名
 * @returns 转发路径文本；非转发消息时返回空串
 */
function forwardPathFor(origin: string | undefined, senderId: number, senderName: string): string {
  return origin ? forwardPathTemplate(origin, `[id:${senderId}] ${senderName}`) : "";
}

/**
 * 格式化排队补跑触发消息的快照描述。
 *
 * @param queuedTrigger 排队补跑的直接触发快照
 * @param rendered 当前群逐字转录的渲染结果与发言人代号表
 * @returns 供排队补跑指令嵌入的触发消息描述文本
 */
function describeQueuedTrigger(queuedTrigger: QueuedReplyTrigger, rendered: RenderedTranscript): string {
  const senderName: string = queuedTrigger.senderName || QUEUED_TRIGGER_FALLBACK_SENDER_NAME;
  return queuedTriggerDescription({
    senderName,
    forwardPath: forwardPathFor(queuedTrigger.forwardedFrom, queuedTrigger.triggerSenderId, senderName),
    text: queuedTrigger.text,
    replyReference: queuedTrigger.replyTo ? rendered.replyReference(queuedTrigger.replyTo) : "",
  });
}

/**
 * 从触发消息或逐字缓存尾部查找唤起者的最近身份快照。
 *
 * @param recent 当前群最近的逐字缓冲消息列表
 * @param triggerMessage 触发本轮回复的热区消息；已滑出热区时为 undefined
 * @param invokerId 直接唤起者的 Telegram userId
 * @returns 匹配到的发言人身份快照；未在热区中找到时返回 undefined
 */
function resolveInvoker(
  recent: BufferedMessage[],
  triggerMessage: BufferedMessage | undefined,
  invokerId: number
): AiSpeakerSnapshot | undefined {
  if (triggerMessage?.id === invokerId) return triggerMessage;
  for (let index: number = recent.length - 1; index >= 0; index -= 1) {
    const message: BufferedMessage = recent[index]!;
    if (message.id === invokerId) return message;
  }
  return undefined;
}

/** buildReplyPromptSections 的入参选项。 */
export interface UserContentOptions {
  /** 本轮触发消息的 message_id。 */
  triggerMessageId: number;
  /** 直接触发时的唤起者 userId；随机触发为 undefined。 */
  directInvokerId?: number;
  /** 是否为随机插话触发。 */
  isRandomTrigger: boolean;
  /** 媒体触发或媒体评价的上下文。 */
  mediaComment?: MediaCommentContext;
  /** 排队补跑的直接触发快照。 */
  queuedTrigger?: QueuedReplyTrigger;
  /** 本轮是否命中手滑抽签。 */
  roundHasTypo: boolean;
}

/**
 * 根据本轮触发类型选择对应的回复指令文案。
 *
 * @param options 本轮触发类型、媒体评价与排队补跑选项
 * @param rendered 当前群逐字转录的渲染结果
 * @returns 对应本轮触发方式的回复指令文本
 */
function replyInstructionFor(
  { mediaComment, queuedTrigger, isRandomTrigger }: UserContentOptions,
  rendered: RenderedTranscript
): string {
  if (mediaComment !== undefined) {
    const mediaForwardNotice: string = forwardedMediaNotice(
      forwardPathFor(mediaComment.forwardedFrom, mediaComment.senderId, mediaComment.senderName)
    );
    if (mediaComment.directTriggerReason === "reply") {
      return mediaReplyTriggerInstruction(mediaComment, mediaForwardNotice);
    }
    if (mediaComment.directTriggerReason === "mention") {
      return mediaMentionTriggerInstruction(mediaComment, mediaForwardNotice);
    }
    return mediaCommentInstruction(mediaComment, mediaForwardNotice, mediaTagHintFor(mediaComment.kind));
  }
  if (queuedTrigger !== undefined) {
    return queuedTriggerInstruction(describeQueuedTrigger(queuedTrigger, rendered));
  }
  if (isRandomTrigger) return RANDOM_TRIGGER_INSTRUCTION;
  return DIRECT_TRIGGER_INSTRUCTION;
}

/**
 * 组装单轮回复的三个对话上下文区块（参考记忆、当前会话及转录已定切点、本轮回复任务）；
 * 群消息缓存为空时返回 null。
 *
 * @param chatId 群聊 ID
 * @param selfInfo 机器人自身身份信息
 * @param options 本轮触发消息、唤起者、媒体与排队补跑选项
 * @returns 组装好的三段上下文与转录切点偏移；群消息缓存为空时返回 null
 */
export function buildReplyPromptSections(
  chatId: number,
  selfInfo: AiBotInfo,
  options: UserContentOptions
): ReplyPromptSections | null {
  const { triggerMessageId, directInvokerId, roundHasTypo }: UserContentOptions = options;
  const buf: BoundedDeque<BufferedMessage> | undefined = chatBuffers.get(chatId);
  if (!buf || buf.size === 0) return null;

  const recent: BufferedMessage[] = buf.last(VERBATIM_CONTEXT_MAX);
  const rendered: RenderedTranscript = buildTieredVerbatimTranscript(recent, {
    selfId: selfInfo.id,
    triggerMessageId,
  });
  const triggerMessage: BufferedMessage | undefined = lookupBufferedMessage(chatId, triggerMessageId);
  const replyInstruction: string = replyInstructionFor(options, rendered);

  const selfIdentity: string = selfIdentityStatement(selfInfo.id, selfInfo.username);

  const summaryQueue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  const summaries: string[] = summaryQueue ? summaryQueue.last(MAX_SUMMARY_ROUNDS) : [];
  const summaryBlock: string = buildColdMemoryBlock(summaries);
  const referenceMemory: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header +
    "\n" +
    selfIdentity +
    "\n\n" +
    (summaryBlock || REPLY_CONTEXT_SECTION_TEXT.referenceMemory.emptyContent) +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.referenceMemory}]`;
  const conversationHead: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.currentConversation.header +
    "\n";
  const currentConversation: string =
    conversationHead +
    rendered.text +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.currentConversation}]`;
  const currentConversationSettledOffsets: number[] = [];
  for (const offset of rendered.settledOffsets) currentConversationSettledOffsets.push(conversationHead.length + offset);
  const invokerSnapshot: AiSpeakerSnapshot | undefined = directInvokerId === undefined
    ? undefined
    : resolveInvoker(recent, triggerMessage, directInvokerId);
  const invokerLine: string = directInvokerId === undefined
    ? ""
    : directInvokerSentence(
      invokerSnapshot ? formatSpeakerIdentity(invokerSnapshot, selfInfo.id) : `[id:${directInvokerId}]`,
      rendered.codeOf.get(directInvokerId) ?? ""
    ) + "\n";
  const replyTask: string =
    `[BEGIN ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]\n` +
    REPLY_CONTEXT_SECTION_TEXT.replyTask.header +
    "\n" +
    invokerLine +
    replyInstruction +
    (roundHasTypo ? "\n\n" + TYPO_REQUIRED_INSTRUCTION : "") +
    "\n" +
    `[END ${REPLY_CONTEXT_SECTION_NAMES.replyTask}]`;
  return { referenceMemory, currentConversation, currentConversationSettledOffsets, replyTask };
}
