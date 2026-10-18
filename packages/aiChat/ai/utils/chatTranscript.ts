import type { BufferedMessage, BufferedReplyReference } from "../../../types/aiChat/memory";
import type { AiSpeakerSnapshot } from "../../../types/aiChat/speaker";
import { FALLBACK_SPEAKER_NAME } from "../../../consts/auto";
import {
  COMPACT_BATCH_SIZE,
  TIER_BOUNDARY_ALIGNMENT,
  TRANSCRIPT_SETTLED_SEGMENT_SIZE,
} from "../../../consts/aiChat/memory";
import {
  COLD_MEMORY_BLOCK_HEADER,
  EARLIER_VERBATIM_BLOCK_HEADER,
  FORWARD_ROSTER_BLOCK_NAME,
  forwardTagTemplate,
  HOT_MEMORY_BLOCK_HEADER,
  messageNumberTag,
  REPLY_TARGET_EVICTED_TAG,
  replyPointerTemplate,
  replyQuoteInlineTemplate,
  replyQuoteTemplate,
  replyTagTemplate,
  rosterEntryTemplate,
  SELF_ROSTER_CODE,
  SELF_SPEAKER_NAME,
  SPEAKER_ROSTER_BLOCK_NAME,
  transcriptDateHeader,
} from "../../../consts/aiChat/prompts/transcript";
import { stripLeadingAtSigns } from "../../../libs/text";

/**
 * 拼接发言人的显示名；首末名均为空白时回退到 FALLBACK_SPEAKER_NAME。
 */
export function displaySpeakerName(speaker: AiSpeakerSnapshot): string {
  const first: string = speaker.firstName;
  const last: string = speaker.lastName;
  if (first && last) return `${first} ${last}`.trim() || FALLBACK_SPEAKER_NAME;
  return (first || last || "").trim() || FALLBACK_SPEAKER_NAME;
}

/**
 * 格式化发言人身份段：selfId 对应账号使用 SELF_SPEAKER_NAME 并省略 username，其余账号带 ID、可选 username 与显示名。
 */
export function formatSpeakerIdentity(speaker: AiSpeakerSnapshot, selfId?: number): string {
  if (speaker.id === selfId) return `[id:${speaker.id}] ${SELF_SPEAKER_NAME}`;
  const usernameTag: string = speaker.username ? ` [username:@${stripLeadingAtSigns(speaker.username)}]` : "";
  return `[id:${speaker.id}]${usernameTag} ${displaySpeakerName(speaker)}`;
}

/** 格式化转发来源标注。 */
function formatForwardTag(forwardedFrom: string | undefined): string {
  return forwardedFrom ? forwardTagTemplate(forwardedFrom) : "";
}

/** 格式化内嵌回复引用标注。 */
function formatReplyReference(reference: BufferedReplyReference, selfId: number | undefined): string {
  const quote: string = reference.quote ? replyQuoteInlineTemplate(reference.quote) : "";
  return replyTagTemplate({
    target: `[message_id:${reference.messageId}] ${formatSpeakerIdentity(reference, selfId)}`,
    text: reference.text,
    forwardTag: formatForwardTag(reference.forwardedFrom),
    quote,
  });
}

/**
 * 将单条缓存消息格式化为包含时间、消息号、完整身份、转发来源与被回复原文的自包含行，供冷历史压缩使用。
 */
export function formatBufferedMessageLine(message: BufferedMessage, selfId?: number): string {
  const isSelf: boolean = message.id === selfId;
  const usernameTag: string = !isSelf && message.username ? ` [username:@${stripLeadingAtSigns(message.username)}]` : "";
  const replyTag: string = message.replyTo ? formatReplyReference(message.replyTo, selfId) : "";
  return `[${message.at}] [message_id:${message.messageId}] [id:${message.id}]${usernameTag} ${isSelf ? SELF_SPEAKER_NAME : displaySpeakerName(message)}${formatForwardTag(message.forwardedFrom)}${replyTag}：${message.text}`;
}

/** buildTieredVerbatimTranscript 的单次渲染上下文。 */
interface TranscriptContext {
  /** 本机器人账号 ID。 */
  readonly selfId: number;
  /** 发送者 ID 到行内短编号的映射；机器人自身固定为 SELF_ROSTER_CODE。 */
  readonly speakers: Map<number, string>;
  /** 发送者 ID 到窗口内末次出现时的身份快照映射，按首次发言顺序排列。 */
  readonly speakerSnapshots: Map<number, AiSpeakerSnapshot>;
  /** 转发来源原串到行内短编号的映射。 */
  readonly origins: Map<string, string>;
  /** 需输出消息号标签的消息集合（窗口内被回复的目标消息与本轮触发消息）。 */
  readonly numbered: Set<number>;
  /** 窗口内存在的 message_id 集合，用于判定回复标注走短指针还是内嵌快照。 */
  readonly present: Set<number>;
  /** 入参中重复的 message_id 条数。 */
  readonly duplicates: number;
}

/** renderRange 的渲染半开区间与切点记录参数。 */
interface TranscriptRange {
  readonly start: number;
  readonly end: number;
  /** 本区间渲染结果首字符在整段转录中的偏移。 */
  readonly offset: number;
  /** 最新消息所在分格的起始序号；序号不超过该值的格边界才记录切点。 */
  readonly settledEnd: number;
  /** 按整段转录内偏移升序追加的切点数组。 */
  readonly settledOffsets: number[];
}

/**
 * 分层逐字转录的渲染结果。
 */
export interface RenderedTranscript {
  readonly text: string;
  /** 发送者 ID 到行内短编号的只读映射。 */
  readonly codeOf: ReadonlyMap<number, string>;
  /** 按当前转录上下文格式化单跳回复引用（窗口内用短指针，窗口外退回内嵌快照）。 */
  readonly replyReference: (reference: BufferedReplyReference) => string;
  /**
   * 已稳定分格切点在 text 中的升序字符偏移，按 TRANSCRIPT_SETTLED_SEGMENT_SIZE 对齐且不含最新未满格。
   */
  readonly settledOffsets: readonly number[];
}

export interface TieredTranscriptOptions {
  /** 机器人自身账号 ID。 */
  readonly selfId: number;
  /** 本轮触发消息的 message_id。 */
  readonly triggerMessageId: number;
}

/**
 * 扫描消息窗口，建立发言人编号表、转发来源编号表及需标注消息号的集合。
 */
function buildTranscriptContext(
  messages: BufferedMessage[],
  { selfId, triggerMessageId }: TieredTranscriptOptions
): TranscriptContext {
  const present: Set<number> = new Set<number>();
  for (const message of messages) present.add(message.messageId);

  const speakers: Map<number, string> = new Map<number, string>();
  const speakerSnapshots: Map<number, AiSpeakerSnapshot> = new Map<number, AiSpeakerSnapshot>();
  const origins: Map<string, string> = new Map<string, string>();
  const numbered: Set<number> = new Set<number>();
  if (present.has(triggerMessageId)) numbered.add(triggerMessageId);

  let userCode: number = 0;
  for (const message of messages) {
    if (!speakers.has(message.id)) {
      speakers.set(message.id, message.id === selfId ? SELF_ROSTER_CODE : `u${(userCode += 1)}`);
    }
    speakerSnapshots.set(message.id, message);
    if (message.forwardedFrom !== undefined && !origins.has(message.forwardedFrom)) {
      origins.set(message.forwardedFrom, `f${origins.size + 1}`);
    }
    const replyTo: BufferedReplyReference | undefined = message.replyTo;
    if (replyTo === undefined) continue;
    if (present.has(replyTo.messageId)) {
      numbered.add(replyTo.messageId);
    } else if (replyTo.forwardedFrom !== undefined && !origins.has(replyTo.forwardedFrom)) {
      origins.set(replyTo.forwardedFrom, `f${origins.size + 1}`);
    }
  }
  return { selfId, speakers, speakerSnapshots, origins, numbered, present, duplicates: messages.length - present.size };
}

/** 构造末尾的发言人名册与可选的转发来源名册区块。 */
function buildRosterBlock(context: TranscriptContext): string {
  const speakerLines: string[] = [];
  for (const [id, snapshot] of context.speakerSnapshots) {
    speakerLines.push(rosterEntryTemplate(context.speakers.get(id)!, formatSpeakerIdentity(snapshot, context.selfId)));
  }
  const originLines: string[] = [];
  for (const [origin, code] of context.origins) originLines.push(rosterEntryTemplate(code, origin));

  return (
    `${SPEAKER_ROSTER_BLOCK_NAME}上面转录的每一行只写编号，编号对应的人看这里；「${SELF_ROSTER_CODE}」就是你自己：\n` +
    speakerLines.join("\n") +
    (originLines.length > 0
      ? `\n\n${FORWARD_ROSTER_BLOCK_NAME}行内「${forwardTagTemplate("f…")}」对应的原始来源看这里：\n` + originLines.join("\n")
      : "")
  );
}

/**
 * 将指定区间渲染为紧凑转录行，跨日期时插入日期分隔行，并在分格边界记录稳定切点。
 */
function renderRange(
  messages: BufferedMessage[],
  context: TranscriptContext,
  { start, end, offset, settledEnd, settledOffsets }: TranscriptRange
): string {
  let rendered: string = "";
  let first: boolean = true;
  let lastDate: string = "";
  for (let index: number = start; index < end; index += 1) {
    const message: BufferedMessage = messages[index]!;
    if (index > start && index <= settledEnd && index % TRANSCRIPT_SETTLED_SEGMENT_SIZE === 0) {
      settledOffsets.push(offset + rendered.length);
    }
    const at: string = message.at;
    const separator: number = at.indexOf(" ");
    if (separator > 0 && (separator !== lastDate.length || !at.startsWith(lastDate))) {
      lastDate = at.slice(0, separator);
      if (!first) rendered += "\n";
      rendered += transcriptDateHeader(lastDate);
      first = false;
    }
    const clock: string = separator > 0 ? at.slice(separator + 1) : at;
    const numberTag: string = context.numbered.has(message.messageId) ? ` ${messageNumberTag(message.messageId)}` : "";
    const forwardTag: string = message.forwardedFrom === undefined
      ? ""
      : forwardTagTemplate(context.origins.get(message.forwardedFrom) ?? message.forwardedFrom);
    if (!first) rendered += "\n";
    rendered +=
      `[${clock}]${numberTag} ${context.speakers.get(message.id) ?? formatSpeakerIdentity(message, context.selfId)}${forwardTag}${formatCompactReplyTag(message.replyTo, context)}：${message.text}`;
    first = false;
  }
  return rendered;
}

/**
 * 格式化紧凑回复标注：目标仍在窗口内时输出消息号指针，已滑出窗口时退回内嵌快照。
 */
function formatCompactReplyTag(
  reference: BufferedReplyReference | undefined,
  context: TranscriptContext
): string {
  if (reference === undefined) return "";
  if (context.present.has(reference.messageId)) {
    return `${replyPointerTemplate(reference.messageId)}${reference.quote ? replyQuoteTemplate(reference.quote) : ""}`;
  }
  const identity: string = context.speakers.get(reference.id) ?? formatSpeakerIdentity(reference, context.selfId);
  const forwardTag: string = reference.forwardedFrom === undefined
    ? ""
    : forwardTagTemplate(context.origins.get(reference.forwardedFrom) ?? reference.forwardedFrom);
  return replyTagTemplate({
    target: `${REPLY_TARGET_EVICTED_TAG} ${identity}`,
    text: reference.text,
    forwardTag,
    quote: reference.quote ? replyQuoteInlineTemplate(reference.quote) : "",
  });
}

/**
 * 将逐字缓存渲染为分层紧凑转录（次要背景区、最热记忆区与末尾名册）并计算稳定切点。
 */
export function buildTieredVerbatimTranscript(
  messages: BufferedMessage[],
  options: TieredTranscriptOptions
): RenderedTranscript {
  const scanned: TranscriptContext = buildTranscriptContext(messages, options);
  const deduped: BufferedMessage[] = scanned.duplicates === 0
    ? messages
    : dedupeByMessageId(messages, scanned.duplicates);
  const context: TranscriptContext = scanned.duplicates === 0
    ? scanned
    : buildTranscriptContext(deduped, options);
  const overflow: number = deduped.length - COMPACT_BATCH_SIZE;
  const hotStart: number = overflow <= 0
    ? 0
    : Math.ceil(overflow / TIER_BOUNDARY_ALIGNMENT) * TIER_BOUNDARY_ALIGNMENT;
  const settledEnd: number =
    Math.floor((deduped.length - 1) / TRANSCRIPT_SETTLED_SEGMENT_SIZE) * TRANSCRIPT_SETTLED_SEGMENT_SIZE;
  const settledOffsets: number[] = [];
  const earlierLines: string = hotStart > 0
    ? renderRange(deduped, context, {
      start: 0,
      end: hotStart,
      offset: EARLIER_VERBATIM_BLOCK_HEADER.length,
      settledEnd,
      settledOffsets,
    })
    : "";
  if (hotStart > 0 && hotStart <= settledEnd) {
    settledOffsets.push(EARLIER_VERBATIM_BLOCK_HEADER.length + earlierLines.length);
  }
  const earlier: string = hotStart > 0 ? EARLIER_VERBATIM_BLOCK_HEADER + earlierLines + "\n\n" : "";
  const text: string =
    earlier +
    HOT_MEMORY_BLOCK_HEADER +
    renderRange(deduped, context, {
      start: hotStart,
      end: deduped.length,
      offset: earlier.length + HOT_MEMORY_BLOCK_HEADER.length,
      settledEnd,
      settledOffsets,
    }) +
    "\n\n" + buildRosterBlock(context);
  return {
    text,
    codeOf: context.speakers,
    replyReference: (reference: BufferedReplyReference): string => formatCompactReplyTag(reference, context),
    settledOffsets,
  };
}

/**
 * 按 message_id 去重并保留每个 message_id 的最后一条记录。
 */
function dedupeByMessageId(messages: BufferedMessage[], duplicates: number): BufferedMessage[] {
  const kept: BufferedMessage[] = new Array<BufferedMessage>(messages.length - duplicates);
  const taken: Set<number> = new Set<number>();
  let cursor: number = kept.length - 1;
  for (let index: number = messages.length - 1; index >= 0; index -= 1) {
    const message: BufferedMessage = messages[index]!;
    if (taken.has(message.messageId)) continue;
    taken.add(message.messageId);
    kept[cursor] = message;
    cursor -= 1;
  }
  return kept;
}

/** 将已滑出逐字区的压缩摘要拼装为冷记忆区块。 */
export function buildColdMemoryBlock(summaries: string[]): string {
  if (summaries.length === 0) return "";
  return (
    COLD_MEMORY_BLOCK_HEADER +
    summaries.map((summary: string, index: number): string => `${index + 1}. ${summary}`).join("\n")
  );
}
