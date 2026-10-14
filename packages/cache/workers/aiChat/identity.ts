/** owner: workers/aiChat。AI Worker 机器人身份、超级管理员 ID 与通知风格快照（packages/workers/aiChatWorker.ts）。 */

import type { Atmosphere } from "../../../types/atmosphere";
import type { AiBotInfo } from "../../../types/aiChat/protocol";

/** 机器人账号身份快照单例：收到主线程 init 消息时注入，resetAiChatIdentityCache 或 Worker 重建时恢复为 null；不淘汰。 */
export const botInfoState: { current: AiBotInfo | null } = { current: null };

/** 超级管理员用户 ID 快照单例（用于重媒体冷却豁免判定）：收到主线程 init 消息时注入，resetAiChatIdentityCache 或 Worker 重建时恢复为 null；不淘汰。 */
export const superAdminUserIdState: { current: number | null } = { current: null };

/** 清空机器人身份、超级管理员 ID 与通知风格快照。 */
export function resetAiChatIdentityCache(): void {
  botInfoState.current = null;
  superAdminUserIdState.current = null;
  atmosphereState.current = null;
}

/** 进程通知风格快照单例：收到主线程 init 消息时注入（Worker 重建时由主线程重放），resetAiChatIdentityCache 或停止时恢复为 null；不淘汰。 */
export const atmosphereState: { current: Atmosphere | null } = { current: null };
