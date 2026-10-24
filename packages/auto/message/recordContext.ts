import type {
  AiRecordMediaMessage,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../types/auto";

/**
 * 文字与各媒体 handler 共用的 Worker 记录载荷构造边界，集中保持身份和回复
 * 关系一致。
 *
 * builder 直接产出完整消息，不创建公共字段投影，也不让调用点用对象展开重建
 * 同构载荷。options 字面量不逃逸，字段按固定顺序一次写齐。
 *
 * 字段顺序即 hidden class 顺序，三个 builder 的公共段保持一致。
 */
export interface BuildAiRecordMessageParams {
  /** 消息触发上下文 */
  context: MessageTriggerContext;
  /** 发言人身份快照 */
  speaker: AiSpeakerSnapshot;
  /** 记入 AI 上下文的正文 */
  text: string;
}

/**
 * 一条文字记录的完整 Worker 载荷。
 *
 * @param params 触发上下文、发言人身份快照与记入 AI 上下文的正文。
 * @returns 投递给 AI Worker 的文字记录载荷。
 */
export function buildAiRecordMessage({
  context,
  speaker,
  text,
}: BuildAiRecordMessageParams): AiRecordMessage {
  return {
    type: "record",
    chatId: context.message.chat.id,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    messageId: context.message.message_id,
    replyTo: context.replyReference,
    forwardedFrom: context.forwardedFrom,
    persistImmediately: false,
    text,
  };
}

/** 按实际发言身份直接构造 AI 文字记录载荷的参数。 */
export interface BuildInlineSenderRecordMessageParams {
  /** 所在群聊 ID */
  readonly chatId: number;
  /** 实际发言人身份快照 */
  readonly speaker: AiSpeakerSnapshot;
  /** Telegram 消息 ID */
  readonly messageId: number;
  /** 记入 AI 上下文的正文 */
  readonly text: string;
}

/**
 * 不经完整触发上下文、按实际发言身份直接记入 AI 上下文的文字载荷（如 gag inline 发言）。
 *
 * @param params 群聊 ID、实际发言人身份、消息 ID 与正文文本。
 * @returns 投递给 AI Worker 的文字记录载荷。
 */
export function buildInlineSenderRecordMessage({
  chatId,
  speaker,
  messageId,
  text,
}: BuildInlineSenderRecordMessageParams): AiRecordMessage {
  return {
    type: "record",
    chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    messageId,
    replyTo: undefined,
    forwardedFrom: undefined,
    persistImmediately: false,
    text,
  };
}

/**
 * 各媒体 handler 写入 `replyTelegramBackpressured` 的构造值：直接触发或已占到
 * 随机评价名额（`claimed`）时为 false，由 aiChat/messageIngress.ts 在投递时刻覆写为
 * 实时快照；不发起回复为 undefined。
 *
 * 判定在 handler 侧算好再作为 options 字段传入，buildAiRecordMediaMessage 只做直接取值。
 *
 * @param context 消息触发上下文
 * @param randomTrigger 随机媒体触发结果
 * @returns 背压字段初始占位值（发起回复时为 `false`，否则为 `undefined`）
 */
export function mediaReplyBackpressurePlaceholder(
  context: MessageTriggerContext,
  randomTrigger: RandomMediaTrigger
): boolean | undefined {
  return context.directTriggerReason !== undefined || randomTrigger === "claimed"
    ? false
    : undefined;
}

/**
 * 媒体记录的构造参数：身份与回复关系之外，其余是逐载荷不同的字段，平铺在同一个
 * options 里直接写进载荷。
 *
 * 媒体字段从协议类型 `Pick` 派生，协议字段变化会让各调用点在编译期同步收敛。
 * 各字段的语义（语音专用的 voiceMime、仅贴纸用的 stickerFallbackText 等）由协议侧 JSDoc 统一声明。
 */
export interface BuildAiRecordMediaMessageParams extends Pick<
  AiRecordMediaMessage,
  | "kind"
  | "caption"
  | "fileId"
  | "fileUniqueId"
  | "width"
  | "height"
  | "replyTelegramBackpressured"
  | "stickerFallbackText"
  | "voiceMime"
> {
  /** 消息触发上下文 */
  context: MessageTriggerContext;
  /** 发言人身份快照 */
  speaker: AiSpeakerSnapshot;
}

/**
 * 一条媒体记录的完整 Worker 载荷。
 *
 * @param params 触发上下文、发言人身份及媒体文件元信息与背压占位字段。
 * @returns 投递给 AI Worker 的媒体记录载荷。
 */
export function buildAiRecordMediaMessage({
  context,
  speaker,
  kind,
  caption,
  fileId,
  fileUniqueId,
  width,
  height,
  replyTelegramBackpressured,
  stickerFallbackText,
  voiceMime,
}: BuildAiRecordMediaMessageParams): AiRecordMediaMessage {
  return {
    type: "recordMedia",
    chatId: context.message.chat.id,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    messageId: context.message.message_id,
    replyTo: context.replyReference,
    forwardedFrom: context.forwardedFrom,
    persistImmediately: false,
    kind,
    caption,
    fileId,
    fileUniqueId,
    width,
    height,
    replyTelegramBackpressured,
    stickerFallbackText,
    voiceMime,
    directTriggerReason: context.directTriggerReason,
    // Worker 按入站占位并异步解析媒体；话题落点随载荷保留到该轮实际发送。
    messageThreadId: context.messageThreadId,
    mediaGroupId: context.message.media_group_id,
  };
}
