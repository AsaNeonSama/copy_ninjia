/**
 * 入群验证踢出终态的播报文案选择。纯函数：不读缓存、不发请求，文案表由调用方传入；
 * terminal.ts 的 expelMember 按本轮成员处置与清理结果调用。
 */

import { VERIFICATION_TIMEOUT_MS } from "../../../consts/antiRaid/verification";
import { formatMinSec } from "../../../libs/time";
import type { AtmosphereNotices } from "../../../types/atmosphereNotices";
import type { ExpelRemovalOutcome, VerificationCleanupResult } from "../../../types/antiRaid/verification";

export interface ExpelNoticeTextOptions {
  /** 当前群风格的提示文案表。 */
  readonly texts: AtmosphereNotices;
  /** 踢出原因（验证超时或待验证期刷屏）。 */
  readonly reason: "timeout" | "flood";
  /** 本轮成员踢出动作的结局。 */
  readonly removalOutcome: ExpelRemovalOutcome;
  /** 是否为本轮确认踢出：本轮踢成，或上一轮已踢成（removalConfirmed）而本轮探测为不在群。 */
  readonly kicked: boolean;
  /** 机器人验证消息的清理结果。 */
  readonly cleanup: VerificationCleanupResult;
  /** 目标成员展示名称。 */
  readonly label: string;
  /** 是否为机器人成员。 */
  readonly isBot: boolean;
}

/**
 * 没踢走时说明原因：成员或群类型未能确认优先，其余按刷屏或超时报踢人失败。踢走后清理有欠账时
 * 报清理结果（被拒绝删除或瞬时失败），清理干净则按刷屏、机器人超时或成员超时播报。
 * @param options 踢出终态播报文案选项。
 * @returns 组装后的群内提示正文。
 */
export function expelNoticeText({
  texts,
  reason,
  removalOutcome,
  kicked,
  cleanup,
  label,
  isBot,
}: ExpelNoticeTextOptions): string {
  if (!kicked) {
    if (removalOutcome === "unconfirmed") return texts.verificationMembershipUnknown(label);
    if (removalOutcome === "kindUnknown") return texts.verificationChatKindUnknown(label);
    return reason === "flood"
      ? texts.verificationFloodKickFailed(label)
      : texts.verificationTimeoutKickFailed(label);
  }
  if (cleanup.missed > 0) {
    return cleanup.permissionDenied
      ? texts.verificationCleanupForbidden(label, cleanup.total, cleanup.missed)
      : texts.verificationCleanupFailed(label, cleanup.missed);
  }
  if (reason === "flood") return texts.verificationFloodKicked(label);
  const timeout: string = formatMinSec(VERIFICATION_TIMEOUT_MS);
  return isBot
    ? texts.verificationBotTimeout(timeout, label)
    : texts.verificationMemberTimeout(label, timeout);
}
