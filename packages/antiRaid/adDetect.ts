/**
 * 广告命中后的主线程处置：在该身份的黑名单串行位里复核开关与免检身份，按 ad_detect_config.json 的
 * 处罚等级选定动作（见 states/adPunishment.ts）。全局封禁写入永久黑名单并落盘，再把跨群封禁登记进
 * durable outbox 交回 Anti-Raid Worker；禁言、只踢不封、本群封禁与频道只删消息见 adPunishment.ts。
 * 候选消息构建位于 adCandidate.ts。
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
import { currentAdDetectPunishment } from "../config/adDetectConfig";
import { AD_DETECT_CONFIG_PATH } from "../consts/paths";
import { resolveAdPunishmentAction } from "../states/adPunishment";
import { formatAdNoticeHead, punishAdSenderInChat } from "./adPunishment";
import type {
  AdDetectedEvent,
  AdVerdictTrueEvent,
} from "../types/antiRaid/adDetect";
import type { AdDetectPunishment } from "../types/config";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { AdSampleDiskMessage } from "../types/diskIO/messages";
import type { FlushResult } from "../types/lifecycle";
import type { AdPunishmentAction } from "../types/states/adPunishment";

/**
 * 黑名单串行位临界区对一次广告命中的裁决：放弃处置的原因，或已选定的处罚动作；全局封禁附带本次是否新加入黑名单。
 */
type AdDisposalRuling =
  /** 群在判定期间关闭了广告检测。 */
  | "disabled"
  /** 发送者在判定期间取得免检权限或进入白名单。 */
  | "protected"
  /** 部署方已在热重载中删除 ad_detect_config.json，没有可用的处罚设置。 */
  | "unconfigured"
  | Readonly<{ action: AdPunishmentAction; newlyBlocked: boolean }>;

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
 * 在身份策略临界区内复核群开关与免检身份，读取当前处罚设置并选定动作；全局封禁在临界区内执行 blockUser。
 *
 * @param event Worker 上报的广告命中事件
 * @returns 本次命中的处置裁决
 */
function ruleAdDisposal(event: AdDetectedEvent): AdDisposalRuling {
  if (getChatState(event.chatId).isAdDetectEnabled !== true) return "disabled";
  if (canBypassAdDetection(event.senderId) || isWhitelisted(event.senderId)) return "protected";
  const punishment: AdDetectPunishment | null = currentAdDetectPunishment();
  if (punishment === null) return "unconfigured";
  clearTemporaryAdBypassActivityOrThrow(event.senderId);
  recordAdSample(event);
  const action: AdPunishmentAction = resolveAdPunishmentAction(punishment, event.isChannel);
  if (action.kind !== "blockGlobal") return { action, newlyBlocked: false };
  return { action, newlyBlocked: blockUser(event.senderId, event.meta) };
}

/**
 * 执行广告命中处置：放弃时只记日志（涉事消息已由 Worker 删除），全局封禁见 enforceGlobalAdBlock，
 * 其余动作交给 adPunishment.ts 在触发群执行。
 *
 * @param event Worker 上报的广告命中事件
 */
async function disposeDetectedAdLocked(event: AdDetectedEvent): Promise<void> {
  if (!await prefetchIdentityPolicies([event.senderId])) {
    logger.error(
      `Dropped the ad detection verdict for sender ${event.senderId} in chat ${event.chatId}: ` +
      "identity policies could not be read, so no punishment was applied."
    );
    return;
  }
  const ruling: AdDisposalRuling = await runProtectedIdentityMutation(
    (): AdDisposalRuling => ruleAdDisposal(event)
  );
  if (ruling === "disabled") {
    logger.log(
      `Ad detection was turned off in chat ${event.chatId} before the verdict for sender ` +
      `${event.senderId} could be disposed; dropping it.`
    );
    return;
  }
  if (ruling === "protected") {
    logger.error(
      `Ad detection flagged protected sender ${event.senderId} in chat ${event.chatId}; ` +
      "refusing to punish the identity."
    );
    return;
  }
  if (ruling === "unconfigured") {
    logger.error(
      `Dropped the ad detection verdict for sender ${event.senderId} in chat ${event.chatId}: ` +
      `${AD_DETECT_CONFIG_PATH} was removed, so no punishment is configured.`
    );
    return;
  }
  if (ruling.action.kind === "blockGlobal") {
    await enforceGlobalAdBlock(event, ruling.newlyBlocked);
    return;
  }
  await punishAdSenderInChat(event, ruling.action);
}

/**
 * 全局封禁：确认黑名单落盘后为受管群登记封禁批次并交回 Worker。同一身份重复命中
 * （newlyBlocked 为 false）时仅补登记触发群的封禁批次。
 *
 * @param event Worker 上报的广告命中事件
 * @param newlyBlocked 本次是否新加入永久黑名单
 */
async function enforceGlobalAdBlock(event: AdDetectedEvent, newlyBlocked: boolean): Promise<void> {
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
        "blocklist entries and removal batches stay in their durable outbox, " +
        "while pending in-chat mutes, kicks and bans are abandoned."
      );
      return "timedOut";
    }
  }
  return "flushed";
}
