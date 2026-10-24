/**
 * 单个发送者待检消息束（AdMessageBundle）的容量裁剪、引用去重、送检切片与文本格式化。
 *
 * 淘汰时优先移除已判定条目（seq <= checkedSeq）；仅当全部条目均未判定且超出
 * AD_DETECT_MAX_MESSAGES_PER_SENDER 时，才丢弃最旧未判定条目的正文并将其 messageId 转入 pendingDeleteIds。
 */

import { logger } from "../../../infra/logger";
import { sanitizeInline } from "../../../libs/text";
import {
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MAX_PENDING_DELETE_IDS,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
} from "../../../consts/antiRaid/adDetect";
import type {
  AdBundleSelection,
  AdCandidateEntry,
  AdMessageBundle,
  AdSampleContext,
} from "../../../types/antiRaid/adDetect";

/**
 * 淘汰超出 AD_DETECT_JUDGED_RETENTION_WINDOW_MS 且已判定（seq <= checkedSeq）的旧上下文条目。
 * @param bundle 待裁剪的发送者消息束。
 * @param now 当前毫秒时间戳。
 */
export function pruneConsumedContext(bundle: AdMessageBundle, now: number): void {
  while (bundle.entries.length > 0) {
    const oldest: AdCandidateEntry | undefined = bundle.entries[0];
    if (
      oldest === undefined ||
      oldest.seq > bundle.checkedSeq ||
      now - oldest.receivedAt < AD_DETECT_JUDGED_RETENTION_WINDOW_MS
    ) break;
    bundle.entries.shift();
  }
}

/**
 * 将消息束裁剪至 AD_DETECT_MAX_MESSAGES_PER_SENDER 上限：先淘汰已判定的旧上下文，
 * 仍超限时淘汰最旧未判定条目并将其 messageId 移入 pendingDeleteIds（上限 AD_DETECT_MAX_PENDING_DELETE_IDS）。
 * @param bundle 待裁剪的发送者消息束。
 */
export function enforceBundleCapacity(bundle: AdMessageBundle): void {
  while (
    bundle.entries.length > AD_DETECT_MAX_MESSAGES_PER_SENDER &&
    (bundle.entries[0]?.seq ?? Number.POSITIVE_INFINITY) <= bundle.checkedSeq
  ) {
    bundle.entries.shift();
  }
  while (bundle.entries.length > AD_DETECT_MAX_MESSAGES_PER_SENDER) {
    const evicted: AdCandidateEntry = bundle.entries.shift()!;
    if (!bundle.uncheckedEvicted) {
      bundle.uncheckedEvicted = true;
      logger.error(
        `Ad detection dropped never-judged message text from sender ${bundle.senderId} in chat ` +
        `${bundle.chatId}: the burst filled the ${AD_DETECT_MAX_MESSAGES_PER_SENDER}-message ` +
        "per-sender limit before the first tick, so that content never reaches the classifier."
      );
    }
    if (bundle.pendingDeleteIds.length >= AD_DETECT_MAX_PENDING_DELETE_IDS) {
      if (!bundle.pendingDeleteOverflowed) {
        bundle.pendingDeleteOverflowed = true;
        logger.error(
          `Ad detection filled the ${AD_DETECT_MAX_PENDING_DELETE_IDS}-id pending-delete list of ` +
          `sender ${bundle.senderId} in chat ${bundle.chatId}; the oldest ad messages will stay in ` +
          "the chat even if the sender is flagged."
        );
      }
      bundle.pendingDeleteIds.shift();
    }
    bundle.pendingDeleteIds.push(evicted.messageId);
  }
}

/**
 * 返回消息束中最新一条消息的序号；消息束为空时返回无待判水位基线。
 * @param bundle 发送者消息束。
 * @returns 最新条目的单调序号；消息束为空时返回 0。
 */
export function latestSeq(bundle: AdMessageBundle): number {
  return bundle.entries[bundle.entries.length - 1]?.seq ?? 0;
}

/**
 * 将隐藏的 text_link URL 拼接在已截断的正文之后（受 AD_DETECT_MAX_LINK_URLS 与 AD_DETECT_LINK_URL_MAX_CHARS 约束）。
 * @param text 已截断的消息正文。
 * @param linkUrls 消息实体中提取的隐藏链接 URL 列表。
 * @returns 拼接去重后隐藏链接的送检文本。
 */
export function appendLinkUrls(
  text: string,
  linkUrls: readonly string[] | undefined
): string {
  if (linkUrls === undefined || linkUrls.length === 0) return text;
  const urls: string[] = [];
  for (const raw of linkUrls) {
    if (urls.length >= AD_DETECT_MAX_LINK_URLS) break;
    const url: string = sanitizeInline(raw).slice(0, AD_DETECT_LINK_URL_MAX_CHARS);
    if (url.length === 0 || text.includes(url) || urls.includes(url)) continue;
    urls.push(url);
  }
  if (urls.length === 0) return text;
  return text.length === 0 ? urls.join(" ") : `${text} ${urls.join(" ")}`;
}

/**
 * 判断消息束现有条目是否已包含指定引文片段。
 * @param entries 消息束现有的条目列表。
 * @param needle 待检查的引文片段。
 * @returns 任一条目正文已包含该片段时返回 true，否则返回 false。
 */
function entriesClaimContextPart(
  entries: readonly AdCandidateEntry[],
  needle: string
): boolean {
  for (const entry of entries) {
    if (entry.text.includes(needle)) return true;
  }
  return false;
}

/**
 * 将尚未被当前正文或同束更早条目包含的被引用段（quote）与被回复原文（replyTo）拼接到送检正文末尾。
 * @param text 当前条目的发送者姓名与正文。
 * @param context 裁剪后的被引用段与被回复原文。
 * @param entries 同束内更早的条目列表。
 * @returns 追加未重复引用内容后的完整送检文本。
 */
export function claimSampleContextParts(
  text: string,
  context: AdSampleContext,
  entries: readonly AdCandidateEntry[]
): string {
  let quote: string = context.quote ?? "";
  if (
    quote.length === 0 ||
    text.includes(quote) ||
    entriesClaimContextPart(entries, quote)
  ) {
    quote = "";
  }
  let replyTo: string = context.replyTo ?? "";
  if (
    replyTo.length === 0 ||
    text.includes(replyTo) ||
    replyTo === quote ||
    entriesClaimContextPart(entries, replyTo)
  ) {
    replyTo = "";
  }
  if (quote.length === 0) {
    if (replyTo.length === 0) return text;
    return text.length === 0 ? replyTo : `${text} ${replyTo}`;
  }
  if (replyTo.length === 0) {
    return text.length === 0 ? quote : `${text} ${quote}`;
  }
  return text.length === 0
    ? `${quote} ${replyTo}`
    : `${text} ${quote} ${replyTo}`;
}

/**
 * 裁剪候选携带的 sampleQuote 与 sampleReplyTo（上限 AD_SAMPLE_CONTEXT_MAX_CHARS），构造样本记录用的 AdSampleContext。
 * @param rawQuote 原始被引用段文本。
 * @param rawReplyTo 原始被回复消息文本。
 * @returns 裁剪后的样本引用上下文；两者均为空或未提供时返回 undefined。
 */
export function boundSampleContext(
  rawQuote: string | undefined,
  rawReplyTo: string | undefined
): AdSampleContext | undefined {
  if (rawQuote === undefined && rawReplyTo === undefined) return undefined;
  const quote: string = (rawQuote ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  const replyTo: string = (rawReplyTo ?? "").slice(0, AD_SAMPLE_CONTEXT_MAX_CHARS);
  if (quote.length === 0 && replyTo.length === 0) return undefined;
  return {
    quote: quote.length === 0 ? undefined : quote,
    replyTo: replyTo.length === 0 ? undefined : replyTo,
  };
}

/**
 * 在 AD_DETECT_BUNDLE_MAX_CHARS 字符预算内，从最旧的未判定条目（seq > checkedSeq）起依次选入待判条目并推进 checkedToSeq，
 * 剩余预算再逆序向前补入紧邻的已判上下文条目。
 * @param bundle 待切片的发送者消息束。
 * @returns 选入本次送检的条目序列及推进后的已检水位 `checkedToSeq`。
 */
export function selectAdBundleEntries(bundle: AdMessageBundle): AdBundleSelection {
  let budget: number = AD_DETECT_BUNDLE_MAX_CHARS;
  let checkedToSeq: number = bundle.checkedSeq;
  const pending: AdCandidateEntry[] = [];
  let firstPendingIndex: number = bundle.entries.length;
  for (let index: number = 0; index < bundle.entries.length; index++) {
    const entry: AdCandidateEntry | undefined = bundle.entries[index];
    if (entry === undefined || entry.seq <= bundle.checkedSeq) continue;
    if (firstPendingIndex === bundle.entries.length) firstPendingIndex = index;
    if (entry.text.length > budget && pending.length > 0) break;
    budget -= entry.text.length;
    pending.push(entry);
    checkedToSeq = entry.seq;
  }
  const context: AdCandidateEntry[] = [];
  for (let index: number = firstPendingIndex - 1; index >= 0; index--) {
    const entry: AdCandidateEntry | undefined = bundle.entries[index];
    if (entry === undefined) continue;
    if (entry.text.length > budget) break;
    budget -= entry.text.length;
    context.push(entry);
  }
  context.reverse();
  for (const entry of pending) context.push(entry);
  return { entries: context, checkedToSeq };
}

/**
 * 将选中的消息条目拼接为按行连续编号的送检文本。
 * @param entries 选入本次送检的条目序列。
 * @returns 按行连续编号的完整送检文本。
 */
export function formatAdBundleText(entries: readonly AdCandidateEntry[]): string {
  return entries
    .map((entry: AdCandidateEntry, index: number): string => `${index + 1}. ${entry.text}`)
    .join("\n");
}

/**
 * 拼出只含当前发送者本人姓名与正文的清单；空行跳过后重新连续编号。
 * @param entries 选入本次送检的条目序列。
 * @returns 仅含发送者本人直发内容的按行编号文本。
 */
export function formatDirectAdBundleText(entries: readonly AdCandidateEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.directText.length === 0) continue;
    lines.push(`${lines.length + 1}. ${entry.directText}`);
  }
  return lines.join("\n");
}

/**
 * 是否有引用、回复或转发内容实际进入了本次模型清单。
 * @param entries 选入本次送检的条目序列。
 * @returns 任一条目的完整送检文本与本人直发文本不同时返回 true，否则返回 false。
 */
export function containsReferencedAdContent(entries: readonly AdCandidateEntry[]): boolean {
  for (const entry of entries) {
    if (entry.text !== entry.directText) return true;
  }
  return false;
}
