/**
 * 广告命中后的 Worker 侧处置副作用：删除涉事消息并将命中事件回投主线程（见 docs/cn/04-invariants.md
 * 与 antiRaid/adDetect.ts 的 announceAdDisposal）。
 */

import { workerAtmosphere } from "../atmosphere";
import { formatUserLabel } from "../../../users/userLabel";
import type { AtmosphereTexts } from "../../../types/atmosphere";
import {
  deleteMessage,
  deleteMessages,
  telegramApi,
} from "../../../infra/telegram";
import { sendTemporaryMessageFromMain } from "../../../infra/telegram/workerClient";
import { logger } from "../../../infra/logger";
import {
  adDetectPublishHolder,
  inFlightReferencedAdCleanupTasks,
} from "../../../cache/workers/antiRaid/adDetect";
import { botCanDeleteIn } from "../botPermissions";
import {
  AD_DETECT_MAX_IN_FLIGHT,
} from "../../../consts/antiRaid/adDetect";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../../consts/telegram";
import type {
  AdCandidateEntry,
  AdDetectedEvent,
  AdMessageBundle,
  AdSampleMessage,
  AdVerdict,
} from "../../../types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../types/telegramWorker";

/** `disposeAdSender` 处置命中广告发送者的参数。 */
export interface DisposeAdSenderParams {
  /** 待处置发送者的待检消息束。 */
  bundle: AdMessageBundle;
  /** 分类器给出的广告判定结果与命中原因。 */
  verdict: AdVerdict;
  /** 本次送检时入选的条目快照（见 bundle.ts 的 selectAdBundleEntries）。 */
  judged: readonly AdCandidateEntry[];
}

/** `deleteReferencedAdMessages` 清理首次引用广告警告前消息的参数。 */
export interface DeleteReferencedAdMessagesParams {
  /** 待清理发送者的待检消息束。 */
  readonly bundle: AdMessageBundle;
  /** 本次送检时入选的条目快照。 */
  readonly judged: readonly AdCandidateEntry[];
  /** 仅清理 message_id 不大于该上界的消息。 */
  readonly messageIdThrough: number;
}

/** `disposalMessageIds` 汇总待删除广告消息 ID 集合的参数。 */
interface DisposalMessageIdsParams {
  /** 本次送检时入选的条目快照。 */
  readonly judged: readonly AdCandidateEntry[];
  /** 消息束内当前保留的候选条目列表。 */
  readonly current: readonly AdCandidateEntry[];
  /** 因束内容量淘汰转存的待删消息 ID 列表。 */
  readonly evictedIds: readonly number[];
  /** 消息 ID 上界；缺省不限制上界。 */
  readonly messageIdThrough?: number;
}

/**
 * 生成处置播报使用的发送者展示标签（见 users/userLabel.ts 的 formatUserLabel）。
 *
 * @param bundle 待检消息束。
 * @param atmosphere 当前 Worker 语言包。
 * @returns 格式化后的发送者展示标签。
 */
function adSenderLabel(bundle: AdMessageBundle, atmosphere: AtmosphereTexts): string {
  return formatUserLabel({
    id: bundle.senderId,
    username: bundle.meta.username,
    first_name: bundle.meta.firstName,
    title: bundle.meta.firstName,
    isChannel: bundle.isChannel,
  }, atmosphere);
}

/**
 * 经主线程临时消息边界发送引用类广告公开警告并挂延迟删除。
 *
 * @param bundle 触发引用警告的待检消息束。
 * @returns 主线程临时消息发送结果；发送失败时返回 `undefined`。
 */
export function warnReferencedAdSender(
  bundle: AdMessageBundle
): Promise<TelegramWorkerTemporaryMessageResult | undefined> {
  const atmosphere: AtmosphereTexts = workerAtmosphere();
  return sendTemporaryMessageFromMain({
    purpose: "adWarning",
    chatId: bundle.chatId,
    identityId: bundle.senderId,
    text: atmosphere.NOTICE_TEXTS.adReferenceWarning(adSenderLabel(bundle, atmosphere)),
  });
}

/**
 * 异步清理首次引用警告覆盖的广告消息（受 AD_DETECT_MAX_IN_FLIGHT 上限约束）。
 *
 * @param params 消息束、送检条目与消息 ID 上界参数。
 */
export function deleteReferencedAdMessages({
  bundle,
  judged,
  messageIdThrough,
}: DeleteReferencedAdMessagesParams): void {
  const messageIds: number[] = disposalMessageIds({
    judged,
    current: bundle.entries,
    evictedIds: bundle.pendingDeleteIds,
    messageIdThrough,
  });
  logger.log(
    `Ad detection warned sender ${bundle.senderId} in chat ${bundle.chatId} for referenced ad content, ` +
    `deleting ${messageIds.length} message(s).`
  );
  if (
    messageIds.length === 0 ||
    inFlightReferencedAdCleanupTasks.size >= AD_DETECT_MAX_IN_FLIGHT
  ) {
    if (messageIds.length > 0) {
      logger.error(
        `Ad detection skipped deleting ${messageIds.length} referenced-ad message(s) ` +
        `in chat ${bundle.chatId}: the cleanup task ceiling is full.`
      );
    }
    return;
  }
  const cleanup: Promise<void> = deleteAdMessages(
    bundle.chatId,
    messageIds
  ).catch((error: unknown): void => {
    logger.error(
      `Unexpected error while deleting referenced ad messages for sender ${bundle.senderId} ` +
      `in chat ${bundle.chatId}:`,
      error
    );
  });
  inFlightReferencedAdCleanupTasks.add(cleanup);
  void cleanup.then((): void => {
    inFlightReferencedAdCleanupTasks.delete(cleanup);
  });
}

/** appendDisposalEntryIds 的入参。 */
export interface AppendDisposalEntryIdsParams {
  /** 待收集消息 ID 的候选条目列表。 */
  readonly entries: readonly AdCandidateEntry[];
  /** 已收集的消息 ID 去重集合。 */
  readonly seen: Set<number>;
  /** 按遍历顺序追加消息 ID 的目标数组。 */
  readonly ids: number[];
  /** 允许计入的最大消息 ID（含）。 */
  readonly messageIdThrough: number;
}

/**
 * 按条目顺序将不大于 `messageIdThrough` 且未见过的消息 ID 追加进 `ids`。
 *
 * @param params 候选条目、已见集合、输出数组与消息 ID 上界。
 */
function appendDisposalEntryIds({
  entries,
  seen,
  ids,
  messageIdThrough,
}: AppendDisposalEntryIdsParams): void {
  for (const entry of entries) {
    if (entry.messageId > messageIdThrough) continue;
    if (seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    ids.push(entry.messageId);
  }
}

/**
 * 汇总本次处置需删除的消息 ID 集合（送检条目 ∪ 当前束内条目 ∪ 淘汰转存的 pendingDeleteIds）。
 *
 * @param params 送检条目、当前束内条目、淘汰待删 ID 与可选消息 ID 上界。
 * @returns 去重后的待删除消息 ID 列表。
 */
function disposalMessageIds({
  judged,
  current,
  evictedIds,
  messageIdThrough = Number.POSITIVE_INFINITY,
}: DisposalMessageIdsParams): number[] {
  const ids: number[] = [];
  const seen: Set<number> = new Set<number>();
  appendDisposalEntryIds({ entries: judged, seen, ids, messageIdThrough });
  appendDisposalEntryIds({ entries: current, seen, ids, messageIdThrough });
  for (const messageId of evictedIds) {
    if (messageId > messageIdThrough || seen.has(messageId)) continue;
    seen.add(messageId);
    ids.push(messageId);
  }
  return ids;
}

/**
 * 删除刚处置发送者在处置抑制窗口内发出的尾随消息，以及已拉黑频道身份的消息（见 states/adDetectAdmission.ts 与 docs/cn/04-invariants.md）。
 *
 * @param chatId 目标群 ID。
 * @param messageId 待删除的尾随消息 ID。
 */
export function deleteStragglerAdMessage(chatId: number, messageId: number): void {
  if (botCanDeleteIn(chatId) === false) return;
  void deleteMessage(chatId, messageId, telegramApi);
}

/**
 * 执行广告命中处置：向主线程发布 adDetected 事件（处罚由主线程按处罚设置执行）并批量删除涉事消息。
 *
 * @param params 待处置消息束、判定结果与送检条目快照。
 */
export async function disposeAdSender({ bundle, verdict, judged }: DisposeAdSenderParams): Promise<void> {
  const messageIds: number[] = disposalMessageIds({
    judged,
    current: bundle.entries,
    evictedIds: bundle.pendingDeleteIds,
  });
  logger.log(
    `Ad detection flagged sender ${bundle.senderId} in chat ${bundle.chatId} ` +
    `on ${judged.length} judged message(s), deleting ${messageIds.length}: ` +
    `${verdict.reason || "no reason given"}.`
  );
  const publish: ((event: AdDetectedEvent) => void) | null = adDetectPublishHolder.current;
  if (publish === null) {
    logger.error(
      `Ad detection could not report sender ${bundle.senderId} in chat ${bundle.chatId}: ` +
      "the main-thread channel is closed; deleting the messages without punishing or announcing."
    );
    await deleteAdMessages(bundle.chatId, messageIds);
    return;
  }
  publish({
    type: "adDetected",
    chatId: bundle.chatId,
    senderId: bundle.senderId,
    isChannel: bundle.isChannel,
    label: adSenderLabel(bundle, workerAtmosphere()),
    meta: bundle.meta,
    reason: verdict.reason,
    messages: judged.map((entry: AdCandidateEntry): AdSampleMessage => ({
      messageId: entry.messageId,
      text: entry.text.length > 0 ? entry.text : entry.stickerSetName ?? "",
      quote: entry.quote,
      replyTo: entry.replyTo,
    })),
  });

  await deleteAdMessages(bundle.chatId, messageIds);
}

/**
 * 按 TELEGRAM_DELETE_MESSAGES_BATCH_MAX 分批删除消息列表。
 *
 * @param chatId 目标群 ID。
 * @param messageIds 待删除的消息 ID 列表。
 */
async function deleteAdMessages(chatId: number, messageIds: readonly number[]): Promise<void> {
  if (botCanDeleteIn(chatId) === false) {
    logger.error(
      `Ad disposal skipped deleting ${messageIds.length} message(s) in chat ${chatId}: ` +
      "the bot is known to lack can_delete_messages there."
    );
    return;
  }
  let failedBatches: number = 0;
  for (let start: number = 0; start < messageIds.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
    const deleted: boolean = await deleteMessages(
      chatId,
      messageIds.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX),
      telegramApi
    );
    if (!deleted) failedBatches++;
  }
  if (failedBatches === 0) return;
  logger.error(
    `Ad disposal could not delete ${failedBatches} batch(es) of ${messageIds.length} message(s) ` +
    `in chat ${chatId}: the bot may lack can_delete_messages, or the messages are older than 48h.`
  );
}
