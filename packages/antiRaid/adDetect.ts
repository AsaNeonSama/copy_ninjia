/**
 * 广告命中后的主线程处置：写入永久黑名单并落盘，再把跨群封禁登记进 durable
 * outbox 交回 Anti-Raid Worker。候选消息构建位于 adCandidate.ts。
 */
import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import { logger } from "../infra/logger";
import { prefetchIdentityPolicies } from "../infra/identityStorage";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { canBypassAdDetection } from "./memberFacts";
import {
  blockUser,
  confirmBlocklistPersisted,
  managedAdminChatIds,
} from "../infra/blocklist/membership";
import { isManagedAdminChat } from "../infra/blocklist/sweepEligibility";
import { trackBlockedRemoval } from "../infra/blocklist/outbox";
import { blockedMemberRemoverHolder, blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { getChatStateCache, getChatState } from "../infra/storage/stateStore";
import { postDiskIODiagnostic } from "../infra/diskIO";
import { sendTemporaryMessageOnMain } from "../infra/telegram/temporaryMessage";
import { inFlightAdDisposals } from "../cache/main/antiRaid/adDisposal";
import { trackBackgroundTask } from "../infra/backgroundTasks";
import { settleWithinBudget } from "../libs/inflight";
import { formatLocalTime } from "../libs/time";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../infra/identityPolicy/temporaryAdBypass";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO/messages";
import type { FlushResult } from "../types/lifecycle";

/**
 * 将命中广告的原始样本经 postDiskIODiagnostic 异步投递至落盘线程（见 infra/diskIO.ts）。
 *
 * @param event Worker 上报的广告命中事件
 */
function recordAdSample(event: AdDetectedEvent): void {
  if (event.messages.length === 0) return;
  const posted: boolean = postDiskIODiagnostic({
    type: "adSample",
    chatId: event.chatId,
    senderId: event.senderId,
    label: event.label,
    detectedAt: formatLocalTime(Date.now()),
    reason: event.reason,
    messages: event.messages,
  } satisfies AdSampleDiskMessage);
  if (!posted) {
    logger.error(`Failed to queue the ad detection sample for sender ${event.senderId} in chat ${event.chatId}.`);
  }
}

/**
 * 执行广告命中处置：写入永久黑名单并落盘，随后为受管群登记封禁批次并交回 Worker。
 * 同一身份重复命中（blockUser 返回 false）时仅补登记触发群的封禁批次。
 *
 * @param event Worker 上报的广告命中事件
 */
async function disposeDetectedAdLocked(event: AdDetectedEvent): Promise<void> {
  if (!await prefetchIdentityPolicies([event.senderId])) {
    logger.error(
      `Dropped the ad detection verdict for sender ${event.senderId} in chat ${event.chatId}: ` +
      "identity policies could not be read, so the sender was not added to the permanent blocklist."
    );
    return;
  }
  const newlyBlocked: boolean | null = await runProtectedIdentityMutation(
    (): boolean | null => {
      if (getChatState(event.chatId).isAdDetectEnabled !== true) return null;
      if (canBypassAdDetection(event.senderId)) return null;
      if (isWhitelisted(event.senderId)) return null;
      clearTemporaryAdBypassActivityOrThrow(event.senderId);
      recordAdSample(event);
      return blockUser(event.senderId, event.meta);
    }
  );
  if (newlyBlocked === null) {
    if (getChatState(event.chatId).isAdDetectEnabled !== true) {
      logger.log(
        `Ad detection was turned off in chat ${event.chatId} before the verdict for sender ` +
        `${event.senderId} could be disposed; dropping it.`
      );
      return;
    }
    logger.error(
      `Ad detection flagged protected sender ${event.senderId} in chat ${event.chatId}; ` +
      "refusing to add the identity to the permanent blocklist."
    );
    return;
  }
  if (newlyBlocked && !await confirmBlocklistPersisted(event.senderId, false)) {
    logger.error(
      `Ad detection blocklist entry for sender ${event.senderId} is memory-only; ` +
      "it will be lost on restart."
    );
  }

  const managed: number[] = managedAdminChatIds(
    event.chatId,
    isManagedAdminChat(getChatStateCache().get(event.chatId))
  );
  const enforcementChatIds: number[] = newlyBlocked
    ? managed
    : managed.filter((chatId: number): boolean => chatId === event.chatId);
  const removals: RemoveBlockedMembersParams[] = [];
  let failedChats: number = 0;
  for (const chatId of enforcementChatIds) {
    try {
      removals.push(trackBlockedRemoval({
        chatId,
        userIds: [event.senderId],
        probeMembership: false,
      }));
    } catch (error: unknown) {
      failedChats++;
      logger.error(
        `Failed to queue the ad removal of sender ${event.senderId} in chat ${chatId}:`,
        error
      );
      requestBlocklistResweep(chatId);
    }
  }
  if (removals.length === 0) {
    logger.error(
      `Ad detection has no chat to enforce the block of sender ${event.senderId} in ` +
      `(${failedChats} chat(s) failed to queue); the blocklist entry still applies to future joins.`
    );
    await announceAdDisposal(event, 0, failedChats);
    return;
  }
  if (failedChats > 0) {
    logger.error(
      `Ad detection could not queue the removal of sender ${event.senderId} in ${failedChats} chat(s); ` +
      "those chats now owe a resweep."
    );
  }
  await blockedMemberRemoverHolder.current(removals);
  logger.log(
    `Ad detection blocked sender ${event.senderId} (${event.reason || "no reason given"}) ` +
    `and queued removals in ${removals.length} chat(s).`
  );
  await announceAdDisposal(event, removals.length, failedChats);
}

/**
 * 按身份串行执行广告封禁与 `/block` 名单写入及跨群扇出（见 cache/main/blocklist.ts 的 blocklistIdentityMutationRunner）。
 *
 * @param event Worker 上报的广告命中事件
 * @returns 广告封禁与跨群扇出处置完成后的 Promise
 */
function disposeDetectedAd(event: AdDetectedEvent): Promise<void> {
  return blocklistIdentityMutationRunner.run(
    event.senderId,
    (): Promise<void> => disposeDetectedAdLocked(event)
  );
}

/** 生成广告处置群内播报文案所需的参数。 */
export interface FormatAdNoticeParams {
  /** 发送者的展示标签（见 users/userLabel.ts 的 formatUserLabel）。 */
  label: string;
  /** 模型返回的判定理由；空串时使用默认文案。 */
  reason: string;
  /** 成功登记封禁批次的群数。 */
  enforcedChats: number;
  /** 登记失败、交由补扫接手的群数。 */
  failedChats: number;
  /** 当前机器人的群氛围文案表。 */
  readonly atmosphere: AtmosphereTexts;
}

/**
 * 生成广告处置群内播报文案，仅包含展示标签、判定理由及封禁群统计，不回显广告原文。
 *
 * @param params 发送者展示标签、判定理由、封禁群统计与氛围文案表
 * @returns 组装完成的广告处置播报 HTML/纯文本文案
 */
export function formatAdNotice({ label, reason, enforcedChats, failedChats, atmosphere }: FormatAdNoticeParams): string {
  const head: string = atmosphere.NOTICE_TEXTS.adDetected(label, reason || atmosphere.NOTICE_TEXTS.adDefaultReason);
  if (enforcedChats === 0) {
    return atmosphere.NOTICE_TEXTS.adNoManagedChat(head);
  }
  if (failedChats > 0) {
    return atmosphere.NOTICE_TEXTS.adPartialBan(head, enforcedChats, failedChats);
  }
  return atmosphere.NOTICE_TEXTS.adBanned(head);
}

/**
 * 经统一临时消息边界发送广告处置播报并登记延迟删除（见 infra/telegram/temporaryMessage.ts）。
 *
 * @param event Worker 上报的广告命中事件
 * @param enforcedChats 成功登记封禁批次的群数
 * @param failedChats 登记封禁批次失败的群数
 */
async function announceAdDisposal(
  event: AdDetectedEvent,
  enforcedChats: number,
  failedChats: number
): Promise<void> {
  await sendTemporaryMessageOnMain({
    chatId: event.chatId,
    text: formatAdNotice({ label: event.label, reason: event.reason, enforcedChats, failedChats, atmosphere: chatAtmosphere() }),
  });
}

/**
 * 接收 Worker 回投的广告命中事件，将处置任务登记入 cache/main/antiRaid/adDisposal.ts 的 inFlightAdDisposals。
 *
 * @param event Worker 上报的广告命中事件
 */
export function handleAdDetected(event: AdDetectedEvent): void {
  trackBackgroundTask(
    inFlightAdDisposals,
    disposeDetectedAd(event),
    `Failed to dispose the ad verdict for sender ${event.senderId}:`
  );
}

/**
 * 预取身份策略并在未持有广告检测豁免时清空发送者的临时免检累计。
 *
 * @param event Worker 上报的模型判定为广告事件
 */
async function clearAdVerdictActivity(event: AdVerdictTrueEvent): Promise<void> {
  if (!await prefetchIdentityPolicies([event.senderId])) return;
  await runProtectedIdentityMutation((): void => {
    if (canBypassAdDetection(event.senderId)) return;
    clearTemporaryAdBypassActivityOrThrow(event.senderId);
  });
}

/**
 * 模型返回广告命中时清空发送者的临时免检累计。
 *
 * @param event Worker 上报的模型判定为广告事件
 */
export function handleAdVerdictTrue(event: AdVerdictTrueEvent): void {
  trackBackgroundTask(
    inFlightAdDisposals,
    clearAdVerdictActivity(event),
    `Failed to clear temporary ad bypass activity for sender ${event.senderId}:`
  );
}

/**
 * 停机排空：在 timeoutMs 预算内等待全部在途广告处置任务结算（含结算期间新派生的任务，见 docs/cn/04-invariants.md）。
 *
 * @param timeoutMs 最大等待超时预算（毫秒）
 * @returns 全部结算返回 flushed；预算耗尽仍有在途任务返回 timedOut。
 */
export async function drainAdDisposals(timeoutMs: number): Promise<FlushResult> {
  const deadline: number = createMonotonicDeadline(timeoutMs);
  while (inFlightAdDisposals.size > 0) {
    const remaining: number = remainingMonotonicTime(deadline);
    if (remaining === 0 || !await settleWithinBudget([...inFlightAdDisposals], remaining)) {
      logger.error(
        `Ad disposal drain timed out with ${inFlightAdDisposals.size} task(s) still in flight; ` +
        "the blocklist entries and removal batches stay in their durable outbox."
      );
      return "timedOut";
    }
  }
  return "flushed";
}
