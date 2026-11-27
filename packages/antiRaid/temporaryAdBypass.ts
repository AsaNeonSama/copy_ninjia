/**
 * 广告检测临时免检与永久白名单晋升的主线程记账入口：统计合规群发言活跃度，
 * 首次达标时通知 Worker 撤销在途广告候选，满晋升条件时写入永久广告免检白名单（见 docs/cn/04-invariants.md）。
 */
import {
  clearTemporaryAdBypassActivity,
  hasActiveTemporaryAdBypassAt,
  recordTemporaryAdBypassActivity,
} from "../infra/identityPolicy/temporaryAdBypass";
import {
  isWhitelisted,
  promoteAdBypassWhitelistMembership,
} from "../infra/identityPolicy/whitelist";
import { logger } from "../infra/logger";
import { messageIdentityMetadata } from "../users/identityMetadata";
import {
  isTemporaryAdBypassActive,
  shouldPromoteToPermanentBypass,
} from "../states/temporaryAdBypass";
import { clearIdentityAdDetection } from "./workerBridge/controller";
import type { AdDetectionMessageContext } from
  "../types/antiRaid/adDetect";
import type { PromoteAdBypassWhitelistResult } from
  "../infra/identityPolicy/whitelist";
import type { TemporaryAdBypassActivity } from
  "../types/states/temporaryAdBypass";

/**
 * 广告检测有效群的一条普通发言计入跨群身份累计；服务消息由调用方先行排除，前置判定
 * 由调用方经 antiRaid/adCandidate.ts 的 adDetectionSenderId 完成。
 * 黑名单身份与黑名单视图冷缺失的身份由 `recordTemporaryAdBypassActivity` 拒绝累计，
 * 不会走到下方的授予边沿与永久晋升。
 *
 * @param context 已通过前置判定的广告检测消息上下文
 * @returns 本条发言是否计入了累计。
 */
export function recordEligibleTemporaryAdBypassActivity(
  {
    message,
    now,
    senderId,
    senderChat,
  }: AdDetectionMessageContext
): boolean {
  if (isWhitelisted(senderId)) return false;
  const wasActive: boolean = hasActiveTemporaryAdBypassAt(senderId, now);
  const activity: Readonly<TemporaryAdBypassActivity> | undefined =
    recordTemporaryAdBypassActivity(senderId, now);
  if (activity === undefined) return false;
  if (!wasActive && isTemporaryAdBypassActive(activity, now)) {
    // 仅在首次达到免检条件时通知 Worker 清理该身份的在途广告检测状态。
    clearIdentityAdDetection(senderId);
  }
  if (shouldPromoteToPermanentBypass(activity)) {
    const promotion: PromoteAdBypassWhitelistResult =
      promoteAdBypassWhitelistMembership(
        senderId,
        messageIdentityMetadata(message, senderChat)
      );
    const temporaryCleared: boolean = clearTemporaryAdBypassActivity(senderId);
    if (!promotion.queued || !temporaryCleared) {
      logger.error(
        "Failed to queue complete temporary-whitelist promotion; retaining unacknowledged final values for replay.",
        { senderId }
      );
    }
  }
  return true;
}
