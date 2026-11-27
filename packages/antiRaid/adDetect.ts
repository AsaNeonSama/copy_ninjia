/**
 * 广告命中后的主线程处置：在该身份的黑名单串行位里复核开关与受保护身份，裁决通过后才删消息并按
 * ad_detect.json 的处罚设置选定动作（见 states/adPunishment.ts）；裁决被拒或非全局封禁处置结算后
 * 立即通知 Anti-Raid Worker 释放 `recentlyDisposedAdKeys`。全局封禁写入永久黑名单并落盘，再把跨群
 * 封禁登记进 durable outbox 交回 Anti-Raid Worker；禁言、只踢不封、本群封禁与频道只删消息见 adPunishment.ts。
 * 若命中事件携带模型归因的广告贴纸包或自定义表情包，则并行经 adBlacklistPersistence.ts 写入 SQLite 并同步 Worker。
 * 候选消息构建位于 adCandidate.ts。
 */
import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import { botCanDeleteMessagesIn } from "../infra/botAdmin";
import { logger } from "../infra/logger";
import { isIdentityPolicyCached, prefetchIdentityPolicies } from "../infra/identityStorage";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../libs/monotonicDeadline";
import { isProtectedFromAdDisposal } from "./memberFacts";
import {
  blockUser,
  confirmBlocklistPersisted,
  managedAdminChatIds,
} from "../infra/blocklist/membership";
import { isManagedAdminChat } from "../infra/blocklist/sweepEligibility";
import { trackBlockedRemoval } from "../infra/blocklist/outbox";
import { blockedMemberRemoverHolder, blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { getChatStateCache, getChatState } from "../infra/chatStateStorage";
import { postDiskIODiagnostic } from "../infra/diskIO";
import { deleteMessages } from "../infra/telegram/actions/messageLifecycle";
import { sendTemporaryMessageOnMain } from "../infra/telegram/temporaryMessage";
import {
  adDetectDedupReleaserHolder,
  inFlightAdDisposals,
} from "../cache/main/antiRaid/adDisposal";
import { trackBackgroundTask } from "../infra/backgroundTasks";
import { settleWithinBudget } from "../libs/inflight";
import { formatLocalTime } from "../libs/time";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../infra/identityPolicy/temporaryAdBypass";
import { currentAdDetectPunishment } from "../config/adDetectConfig";
import { AD_DETECT_CONFIG_PATH } from "../consts/paths";
import { deleteMessageIdBatches } from "../libs/messageDeletion";
import { resolveAdPunishmentAction } from "../states/adPunishment";
import { persistAutoBlacklistedAdPacks } from "./adBlacklistPersistence";
import { formatAdNoticeHead, punishAdSenderInChat } from "./adPunishment";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type { AdDetectPunishment } from "../types/config";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO/messages";
import type { FlushResult } from "../types/lifecycle";
import type {
  AdInChatPunishmentAction,
  AdPunishmentAction,
} from "../types/states/adPunishment";

/** `enforceGlobalAdBlock` 登记并派发跨群封禁批次后的结算结果。 */
interface GlobalAdBlockResult {
  /** 成功登记封禁批次的群数。 */
  readonly enforcedChats: number;
  /** 登记失败、转入补扫的群数。 */
  readonly failedChats: number;
  /** 触发群的移除批次是否已交回 Anti-Raid Worker（由 `blocklistEffects` 负责释放处置抑制标记）。 */
  readonly triggerChatHandedOff: boolean;
}

/**
 * 黑名单串行位临界区对一次广告命中的裁决：放弃处置的原因、已在临界区写入黑名单的全局封禁，或本群处罚动作。
 */
type AdDisposalRuling =
  /** 群在判定期间关闭了广告检测。 */
  | "disabled"
  /** 发送者在判定期间取得免检权限或进入白名单。 */
  | "protected"
  /** 部署方已在热重载中删除 ad_detect.json，没有可用的处罚设置。 */
  | "unconfigured"
  /** 身份策略在临界区内未能读取，放弃本次处置。 */
  | "unavailable"
  /** 全局封禁；newlyBlocked 为本次 blockUser 是否新加入永久黑名单。 */
  | Readonly<{ kind: "blockGlobal"; newlyBlocked: boolean }>
  | AdInChatPunishmentAction;

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
    logger.error(
      "Failed to queue the ad detection sample.",
      { chatId: event.chatId, senderId: event.senderId }
    );
  }
}

/**
 * 在身份策略临界区内复核群开关与免检身份，读取当前处罚设置并选定动作；全局封禁在临界区内执行 blockUser。
 *
 * @param event Worker 上报的广告命中事件
 * @returns 本次命中的处置裁决
 */
function ruleAdDisposal(event: AdDetectedEvent): AdDisposalRuling {
  if (getChatState(event.chatId).isAdDetectEnabled !== true) return "disabled";
  if (isProtectedFromAdDisposal(event.senderId)) return "protected";
  const punishment: AdDetectPunishment | null = currentAdDetectPunishment();
  if (punishment === null) return "unconfigured";
  clearTemporaryAdBypassActivityOrThrow(event.senderId);
  recordAdSample(event);
  const action: AdPunishmentAction = resolveAdPunishmentAction(punishment, event.isChannel);
  if (action.kind !== "blockGlobal") return action;
  return { kind: "blockGlobal", newlyBlocked: blockUser(event.senderId, event.meta) };
}

/**
 * 在主线程按 TELEGRAM_DELETE_MESSAGES_BATCH_MAX 分批删除经裁决确认需清理的涉事广告消息。
 *
 * @param chatId 目标群 ID
 * @param messageIds 待删除的消息 ID 列表
 */
async function deleteAdMessagesOnMain(
  chatId: number,
  messageIds: readonly number[]
): Promise<void> {
  if (messageIds.length === 0) return;
  if (botCanDeleteMessagesIn(chatId) === false) {
    logger.error(
      "Ad disposal skipped deleting messages; the bot is known to lack can_delete_messages there.",
      { chatId, messageCount: messageIds.length }
    );
    return;
  }
  const failedBatches: number = await deleteMessageIdBatches(
    messageIds,
    (batch: readonly number[]): Promise<boolean> => deleteMessages(chatId, batch)
  );
  if (failedBatches === 0) return;
  logger.error(
    "Ad disposal could not delete message batches; the bot may lack can_delete_messages, or the messages are older than 48h.",
    { chatId, failedBatchCount: failedBatches, messageCount: messageIds.length }
  );
}

/**
 * 裁决通过后并行登记涉事消息删除任务到 `inFlightAdDisposals`，既不阻塞处罚与播报，又确保停机排空等待完成。
 *
 * @param event Worker 上报的广告命中事件
 */
function scheduleDeleteAdMessages(event: AdDetectedEvent): void {
  if (event.deleteMessageIds.length === 0) return;
  trackBackgroundTask(
    inFlightAdDisposals,
    deleteAdMessagesOnMain(event.chatId, event.deleteMessageIds),
    {
      message: "Failed to delete ad detection messages:",
      context: { chatId: event.chatId, senderId: event.senderId },
    }
  );
}

/**
 * 执行广告命中处置：放弃时绝不删消息并立即释放 Worker 处置抑制标记；裁决通过后才删消息并按处罚设置执行
 * 全局封禁（enforceGlobalAdBlock）或本群处罚（adPunishment.ts），非全局封禁或未把触发群批次交回 Worker 时
 * 在 finally 中释放处置抑制标记。
 *
 * @param event Worker 上报的广告命中事件
 */
async function disposeDetectedAdLocked(event: AdDetectedEvent): Promise<void> {
  let releaseDedup: boolean = true;
  try {
    if (!await prefetchIdentityPolicies([event.senderId])) {
      logger.error(
        "Dropped the ad detection verdict; identity policies could not be read, so no punishment was applied.",
        { chatId: event.chatId, senderId: event.senderId }
      );
      return;
    }
    const ruling: AdDisposalRuling = await runProtectedIdentityMutation(
      async (): Promise<AdDisposalRuling> => {
        if (
          !isIdentityPolicyCached(event.senderId) &&
          !await prefetchIdentityPolicies([event.senderId])
        ) {
          return "unavailable";
        }
        return ruleAdDisposal(event);
      }
    );
    if (ruling === "unavailable") {
      logger.error(
        "Dropped the ad detection verdict; identity policies could not be read, so no punishment was applied.",
        { chatId: event.chatId, senderId: event.senderId }
      );
      return;
    }
    if (ruling === "disabled") {
      logger.info(
        "Ad detection was turned off in chat before the verdict could be disposed; dropping it.",
        { chatId: event.chatId, senderId: event.senderId }
      );
      return;
    }
    if (ruling === "protected") {
      logger.error(
        "Ad detection flagged protected sender; refusing to punish the identity.",
        { chatId: event.chatId, senderId: event.senderId }
      );
      return;
    }
    if (ruling === "unconfigured") {
      logger.error(
        "Dropped the ad detection verdict; ad detection config was removed, so no punishment is configured.",
        { chatId: event.chatId, senderId: event.senderId, configPath: AD_DETECT_CONFIG_PATH }
      );
      return;
    }
    scheduleAutoBlacklistAdPacks(event);
    scheduleDeleteAdMessages(event);
    if (ruling.kind === "blockGlobal") {
      const result: GlobalAdBlockResult = await enforceGlobalAdBlock(event, ruling.newlyBlocked);
      releaseDedup = !result.triggerChatHandedOff;
      await announceAdDisposal(event, result.enforcedChats, result.failedChats);
      return;
    }
    await punishAdSenderInChat(event, ruling);
  } finally {
    if (releaseDedup) {
      adDetectDedupReleaserHolder.current?.(event.chatId, event.senderId);
    }
  }
}

/**
 * 命中事件带有待自动拉黑的贴纸包或自定义表情包时，将写回任务并行登记到 `inFlightAdDisposals`，
 * 既不延迟发送者处罚，又确保停机排空等待落盘完成；写回异常由 `trackBackgroundTask` 统一记录。
 *
 * @param event Worker 上报的广告命中事件
 */
function scheduleAutoBlacklistAdPacks(event: AdDetectedEvent): void {
  if (
    (event.adStickerPacks?.length ?? 0) === 0 &&
    (event.adEmojiPacks?.length ?? 0) === 0
  ) return;
  trackBackgroundTask(
    inFlightAdDisposals,
    persistAutoBlacklistedAdPacks({
      stickerPacks: event.adStickerPacks ?? [],
      emojiPacks: event.adEmojiPacks ?? [],
    }),
    {
      message: "Failed to persist auto-blacklisted ad packs:",
      context: { chatId: event.chatId, senderId: event.senderId },
    }
  );
}

/**
 * 全局封禁：确认黑名单落盘后为受管群登记封禁批次并交回 Worker。同一身份重复命中
 * （newlyBlocked 为 false）时仅补登记触发群的封禁批次。
 *
 * @param event Worker 上报的广告命中事件
 * @param newlyBlocked 本次是否新加入永久黑名单
 * @returns 已登记群数、登记失败群数，以及触发群移除批次是否已移交 Worker
 */
async function enforceGlobalAdBlock(
  event: AdDetectedEvent,
  newlyBlocked: boolean
): Promise<GlobalAdBlockResult> {
  if (newlyBlocked && !await confirmBlocklistPersisted(event.senderId, false)) {
    logger.error(
      "Ad detection blocklist entry is memory-only; it will be lost on restart.",
      { senderId: event.senderId }
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
        "Failed to queue the ad removal of sender:",
        { chatId, senderId: event.senderId },
        error
      );
      requestBlocklistResweep(chatId);
    }
  }
  if (removals.length === 0) {
    logger.error(
      "Ad detection has no chat to enforce the block in; the blocklist entry still applies to future joins.",
      { senderId: event.senderId, failedChatCount: failedChats }
    );
    return { enforcedChats: 0, failedChats, triggerChatHandedOff: false };
  }
  if (failedChats > 0) {
    logger.error(
      "Ad detection could not queue removal in some chats; those chats now owe a resweep.",
      { senderId: event.senderId, failedChatCount: failedChats }
    );
  }
  await blockedMemberRemoverHolder.current(removals);
  const triggerChatHandedOff: boolean = removals.some(
    (params: RemoveBlockedMembersParams): boolean => params.chatId === event.chatId
  );
  logger.info(
    "Ad detection blocked sender and queued removals.",
    {
      senderId: event.senderId,
      reason: event.reason || null,
      queuedChatCount: removals.length,
    }
  );
  return { enforcedChats: removals.length, failedChats, triggerChatHandedOff };
}

/**
 * 按身份串行执行广告处置与 `/block` 名单写入及跨群扇出（见 cache/main/blocklist.ts 的 blocklistIdentityMutationRunner）。
 *
 * @param event Worker 上报的广告命中事件
 * @returns 广告处置完成后的 Promise
 */
function disposeDetectedAd(event: AdDetectedEvent): Promise<void> {
  return blocklistIdentityMutationRunner.run(
    event.senderId,
    (): Promise<void> => disposeDetectedAdLocked(event)
  );
}

/** 生成全局封禁播报文案所需的参数。 */
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
 * 生成全局封禁的群内播报文案，仅包含展示标签、判定理由及封禁群统计，不回显广告原文。
 *
 * @param params 发送者展示标签、判定理由、封禁群统计与氛围文案表
 * @returns 组装完成的广告处置播报 HTML/纯文本文案
 */
export function formatAdNotice({ label, reason, enforcedChats, failedChats, atmosphere }: FormatAdNoticeParams): string {
  const head: string = formatAdNoticeHead({ label, reason, atmosphere });
  if (enforcedChats === 0) {
    return atmosphere.NOTICE_TEXTS.adNoManagedChat(head);
  }
  if (failedChats > 0) {
    return atmosphere.NOTICE_TEXTS.adPartialBan(head, enforcedChats, failedChats);
  }
  return atmosphere.NOTICE_TEXTS.adBanned(head);
}

/**
 * 经统一临时消息边界发送全局封禁播报并登记延迟删除（见 infra/telegram/temporaryMessage.ts）。
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
    {
      message: "Failed to dispose the ad verdict:",
      context: { chatId: event.chatId, senderId: event.senderId },
    }
  );
}

/**
 * 预取身份策略并在未持有广告检测豁免时清空发送者的临时免检累计。
 *
 * @param event Worker 上报的模型判定为广告事件
 */
async function clearAdVerdictActivity(event: AdVerdictTrueEvent): Promise<void> {
  if (!await prefetchIdentityPolicies([event.senderId])) return;
  await runProtectedIdentityMutation(async (): Promise<void> => {
    if (
      !isIdentityPolicyCached(event.senderId) &&
      !await prefetchIdentityPolicies([event.senderId])
    ) {
      return;
    }
    if (isProtectedFromAdDisposal(event.senderId)) return;
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
    {
      message: "Failed to clear temporary ad bypass activity:",
      context: { senderId: event.senderId },
    }
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
        "Ad disposal drain timed out with tasks still in flight; blocklist entries and removal batches stay in their durable outbox, while pending in-chat mutes, kicks and bans are abandoned.",
        { inFlightTaskCount: inFlightAdDisposals.size }
      );
      return "timedOut";
    }
  }
  return "flushed";
}
