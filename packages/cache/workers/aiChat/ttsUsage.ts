/** owner: workers/aiChat。语音合成每日配额计数与在途预留状态（packages/aiChat/ai/ttsUsage.ts）。 */

import type { TtsDailyUsage } from "../../../types/aiChat/voiceMessage";

/**
 * 语音合成每日窗口与已用计数；null 表示尚未发起过合成请求。
 * 填充：主线程 hydrateTtsUsage 注入或合成成功后整槽替换（并向主线程发送 ttsUsage 回执落盘）。
 * 清理：窗口过期后在下一次登记时重置为新窗口。
 * 重建：Worker 崩溃重启后由主线程重放最新 ttsUsage 回执恢复。
 * 容量：恒为单个对象槽位。
 */
export const ttsDailyUsage: { current: TtsDailyUsage | null } = { current: null };

/**
 * 已通过 send_voice 准入但尚未结算的 AI 语音合成预留计数。
 * 填充：reserveAiTtsUsage 准入通过时递增；清理：settleAiTtsReservation 在合成结束时递减；重建：Worker 崩溃重启后从零开始；容量：不超过同时在途的 send_voice 合成数（单轮上限 MAX_VOICES_PER_REPLY）。
 */
export const pendingAiTtsReservations: { current: number } = { current: 0 };
