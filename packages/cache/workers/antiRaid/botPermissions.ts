/** owner: workers/antiRaid。机器人群内管理权限位的只读镜像（packages/workers/antiRaid/botPermissions.ts）。 */

import type { BotActionPermissions } from "../../../types/telegram";

/**
 * chatId -> 机器人在该群的管理权限位只读镜像。
 * 权威线程为主线程（`ChatState.botPermissions`）；填充：主线程确证或作废权限时发送 `botPermissionsChanged` 按群增量写入或删除。
 * 清理：离群、`/init` 切换、deactivateChat 或 Worker 停止时删除。
 * 重建与重放：进程启动或 Worker 崩溃重建时由主线程整表重放（packages/antiRaid/workerBridge/replay.ts）。
 * 无条目含义：表示权限状态未知而非无权限；调用方仅在确证对应权限位为 false 时放弃请求，未知时照常发起请求。
 * 容量：与主线程已确证权限的受管群数同阶（上限 STATE_MANAGED_CHAT_LIMIT）。
 */
export const workerBotChatPermissions: Map<number, BotActionPermissions> = new Map();
