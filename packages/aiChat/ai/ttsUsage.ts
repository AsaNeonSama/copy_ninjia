/**
 * 语音合成每日用量的窗口计数、AI 预留结算与主线程持久化同步（线程与持久化约束见 docs/cn/04-invariants.md）。
 */

import { pendingAiTtsReservations, ttsDailyUsage } from "../../cache/workers/aiChat/ttsUsage";
import { agentTtsConfig } from "../../config/agent";
import { activeTtsUsage, ttsQuotaLimit } from "./utils/ttsUsageWindow";
import type { AgentTtsCapabilityConfig } from "../../types/config";
import type { AiTtsUsageEvent } from "../../types/aiChat/protocol";
import type { TtsDailyUsage, TtsOperatorClaim, TtsQuotaScope } from "../../types/aiChat/voiceMessage";

declare const self: Worker;

/**
 * 注入主线程恢复或重放的每日用量快照。
 * @param usage 主线程恢复的每日用量快照；无记录时为 null。
 */
export function hydrateTtsUsage(usage: TtsDailyUsage | null): void {
  ttsDailyUsage.current = usage;
}

/**
 * 更新本地权威计数并通过 ttsUsage 事件上报主线程。
 * @param usage 最新的每日用量快照；归零清空时为 null。
 */
function publishTtsUsage(usage: TtsDailyUsage | null): void {
  ttsDailyUsage.current = usage;
  self.postMessage({ type: "ttsUsage", usage } satisfies AiTtsUsageEvent);
}

/**
 * 按 scope 递增当前窗口计数并上报全量快照；窗口未建立或已过期时以 now 开启新窗口。
 * @param scope 配额口径（ai 或 operator）。
 * @param now 当前毫秒时间戳。
 * @returns 本次记录归属的窗口起始毫秒时间戳。
 */
function recordTtsUsage(scope: TtsQuotaScope, now: number): number {
  const current: TtsDailyUsage | null = activeTtsUsage(ttsDailyUsage.current, now);
  const windowStartedAt: number = current?.windowStartedAt ?? now;
  publishTtsUsage({
    windowStartedAt,
    agentCount: (current?.agentCount ?? 0) + (scope === "ai" ? 1 : 0),
    reserveCount: (current?.reserveCount ?? 0) + (scope === "operator" ? 1 : 0),
  });
  return windowStartedAt;
}

/**
 * 计算当前窗口内已落账的 agentCount 与在途预留之和。
 * @param now 当前毫秒时间戳。
 * @returns 当前窗口内 AI 口径已占用次数。
 */
function aiTtsUsed(now: number): number {
  return (activeTtsUsage(ttsDailyUsage.current, now)?.agentCount ?? 0) + pendingAiTtsReservations.current;
}

/**
 * 登记一次 operator 口径的合成请求并上报计数；已达 dailyLimit 时返回 null。
 * @param dailyLimit operator 口径每日上限。
 * @param now 当前毫秒时间戳。
 * @returns 登记凭据（含归属窗口起始时间戳）；额度已满时返回 null。
 */
export function claimOperatorTtsUsage(dailyLimit: number, now: number = Date.now()): TtsOperatorClaim | null {
  if ((activeTtsUsage(ttsDailyUsage.current, now)?.reserveCount ?? 0) >= dailyLimit) return null;
  return { windowStartedAt: recordTtsUsage("operator", now) };
}

/**
 * 退还一次同窗口内的 operator 登记并上报更新后的快照；两项计数均归零时上报 null。
 * @param claim 先前由 claimOperatorTtsUsage 返回的登记凭据。
 * @param now 当前毫秒时间戳。
 */
export function refundOperatorTtsUsage(claim: TtsOperatorClaim, now: number = Date.now()): void {
  const current: TtsDailyUsage | null = activeTtsUsage(ttsDailyUsage.current, now);
  if (current?.windowStartedAt !== claim.windowStartedAt || current.reserveCount === 0) return;
  const reserveCount: number = current.reserveCount - 1;
  publishTtsUsage(reserveCount === 0 && current.agentCount === 0
    ? null
    : { windowStartedAt: current.windowStartedAt, agentCount: current.agentCount, reserveCount });
}

/**
 * 预留一次 ai 口径额度；已用加在途预留达到 dailyLimit 时返回 false。
 * @param dailyLimit AI 口径每日上限。
 * @param now 当前毫秒时间戳。
 * @returns 预留成功时返回 true，额度已满时返回 false。
 */
export function reserveAiTtsUsage(dailyLimit: number, now: number = Date.now()): boolean {
  if (aiTtsUsed(now) >= dailyLimit) return false;
  pendingAiTtsReservations.current++;
  return true;
}

/**
 * 结清一次 ai 口径预留：成功时递增 agentCount 并上报，失败或取消时仅释放预留计数。
 * @param succeeded TTS 供应商语音合成调用是否成功完成。
 * @param now 当前毫秒时间戳。
 */
export function settleAiTtsReservation(succeeded: boolean, now: number = Date.now()): void {
  pendingAiTtsReservations.current--;
  if (succeeded) recordTtsUsage("ai", now);
}

/**
 * 计算当前窗口内 AI 语音工具剩余可用次数；未配置 TTS 时返回零。
 * @param now 当前毫秒时间戳。
 * @returns 当前窗口内 AI 口径剩余可用次数（非负整数）。
 */
export function aiTtsRemaining(now: number = Date.now()): number {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  if (tts === undefined) return 0;
  return Math.max(0, ttsQuotaLimit(tts, "ai") - aiTtsUsed(now));
}
