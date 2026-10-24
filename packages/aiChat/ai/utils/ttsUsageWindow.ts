/**
 * 语音合成每日计数的窗口判定与额度口径，纯函数叶子模块：AI Worker 的 tts 门面、登记与
 * 余量计算（aiChat/provider.ts、aiChat/ai/ttsUsage.ts）共用，不接触任何缓存。
 */

import { TTS_USAGE_WINDOW_MS } from "../../../consts/aiChat/voiceMessage";
import { isRecordedWithin } from "../../../libs/clockWindow";
import type { AgentTtsCapabilityConfig } from "../../../types/config";
import type { TtsDailyUsage, TtsQuotaScope } from "../../../types/aiChat/voiceMessage";

/**
 * now 时刻仍有效的计数窗口；从没用过、距窗口起点已满 TTS_USAGE_WINDOW_MS、或窗口起点
 * 晚于 now（墙钟回拨，按窗口已结束处理，见 libs/clockWindow.ts）时为 null，不修改输入。
 * @param usage 已记录的每日用量快照；未建立时为 null。
 * @param now 当前毫秒时间戳。
 * @returns 仍处于有效期内的每日用量快照；已过期或为空时返回 null。
 */
export function activeTtsUsage(usage: TtsDailyUsage | null, now: number): TtsDailyUsage | null {
  if (usage === null || !isRecordedWithin(usage.windowStartedAt, now, TTS_USAGE_WINDOW_MS - 1)) return null;
  return usage;
}

/**
 * 独立每日上限：`operator` 为 dailyReserveQuota，`ai` 为 dailyLimit - dailyReserveQuota。
 * @param tts 语音合成能力配置。
 * @param scope 配额口径（ai 或 operator）。
 * @returns 对应口径的每日独立可用上限。
 */
export function ttsQuotaLimit(tts: AgentTtsCapabilityConfig, scope: TtsQuotaScope): number {
  return scope === "ai" ? tts.dailyLimit - tts.dailyReserveQuota : tts.dailyReserveQuota;
}
