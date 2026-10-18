/** owner: main。私密模式的主线程持久化对账与紧急恢复状态（packages/antiRaid/lockdownMirror.ts 与
 * packages/antiRaid/workerBridge/events.ts）。 */

import type {
  EmergencyLockdownRecovery,
  PersistedLockdownFingerprint,
} from "../../../types/antiRaid/internal";

/**
 * 各群当前 lockdown 记录已确认落盘的指纹（`phase`、`intentId`、`announced`，见
 * types/antiRaid/internal.ts 的 PersistedLockdownFingerprint）。
 *
 * 填充：initAntiRaid 启动时从已加载的 SQLite 记录播种；persistCurrentLockdown 在 SQLite ACK
 * 成功且记录未被新事件覆盖后写入并通知 Worker。
 * 清理：Worker 上报新的 lockdown 持久化事实或 unlock、落盘失败、紧急恢复成功或群不可达放弃恢复时删除。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；进程重启后从 SQLite 记录重建。
 */
export const persistedLockdownFingerprints: Map<number, PersistedLockdownFingerprint> = new Map();

/**
 * 正在等待 SQLite 落盘确认的群集合，每群至多一项。
 * 填充：persistCurrentLockdown 启动对账循环时加入。清理：该群对账循环 finally 时移除。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT；进程重启后从空集开始。
 */
export const pendingLockdownPersistence: Set<number> = new Set();

/**
 * 对账循环在途期间收到新 lockdown 事件的群集合。
 * 填充：persistCurrentLockdown 在该群已有在途循环时加入。清理：每轮循环读取最新状态前移除。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT；进程重启后从空集开始。
 */
export const queuedLockdownPersistence: Set<number> = new Set();

/**
 * Anti-Raid Worker 放弃自愈后由主线程接管的各群权限紧急恢复任务。
 * 填充：recoverAbandonedLockdowns 为仍处私密模式的群启动恢复时写入。
 * 清理：恢复成功、显式 unlock、群不可达放弃恢复或 terminate 时删除。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰；进程重启后从空表开始。
 */
export const emergencyLockdownRecoveries: Map<number, EmergencyLockdownRecovery> = new Map();

/** 主线程紧急恢复的停止标志；initAntiRaid 置 false，terminate 置 true，容量为一个布尔值。 */
export const emergencyLockdownRecoveryRuntime: { stopped: boolean } = { stopped: true };
