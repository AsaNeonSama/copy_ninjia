/** owner: workers/aiChat。AI 心情状态（packages/aiChat/ai/mood.ts）。 */

import type { CurrentMood } from "../../../types/aiChat/mood";

/**
 * 当前心情档位与到期时刻；null 表示尚未抽取或原档位已从配置移除。
 * 填充：switchMood 在首次读取、到期重抽或 /mood switch 时写入；refreshMood 在配置热重载后更新同名档位。
 * 清理：配置移除原档位或 resetAiChatMoodCache 时置空。
 * 重建：Worker 崩溃重启后从 null 开始，下次拼提示词时重抽。
 * 容量：恒为单个槽位，到期后在下次读取时覆盖。
 */
export const currentMoodState: { current: CurrentMood | null } = { current: null };

/** 清空当前心情状态。 */
export function resetAiChatMoodCache(): void {
  currentMoodState.current = null;
}
