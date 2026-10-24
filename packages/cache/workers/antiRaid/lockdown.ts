/** owner: workers/antiRaid。私密模式状态机与入群滑窗状态（packages/workers/antiRaid/lockdownRuntime.ts）。 */

import { createKeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../../libs/keyedSerialTaskRunner";
import type { JoinWindow, LockdownEntry } from "../../../types/antiRaid/internal";

/**
 * chatId -> 最近入群时间戳滑窗与静默到期 timer。
 * 填充：recordJoinWindow 在新成员入群时写入；清理：静默超时、私密模式解锁或抑制再次触发时调 clearJoinWindow、群停用或 Worker 停止时删除；重建：Worker 重启后从空表开始；容量：单群上限为 JOIN_WINDOW_CAPACITY 个时间戳与单个 timer，群数受 STATE_MANAGED_CHAT_LIMIT 约束。
 */
export const joinWindows: Map<number, JoinWindow> = new Map();

/**
 * chatId -> 私密模式状态机条目与恢复 timer。
 * 填充：触发私密模式或从主线程 lockdown 镜像接管恢复时写入。
 * 清理：解锁恢复完成、群停用或 Worker 停止时删除。
 * 重建：Worker 崩溃重启后由主线程重放 ChatState.lockdown 持久快照接管恢复。
 * 容量：每个受管群至多一条，上限为 STATE_MANAGED_CHAT_LIMIT，不设容量淘汰。
 */
export const lockdownEntries: Map<number, LockdownEntry> = new Map();

/**
 * chatId -> 抑制再次触发私密模式的截止时间戳。
 * 填充：私密模式启动作废时由 beginLockdownRetriggerCooldown 写入。
 * 清理：到期后在下一次 recordJoin 或新条目写入时清理，群停用按群删除，stopLockdownRuntime 清空。
 * 重建：Worker 崩溃重启后从空表开始（无条目表示不抑制触发）。
 * 容量：不超过受管群数。
 */
export const lockdownRetriggerCooldowns: Map<number, number> = new Map();

/**
 * chatId -> 私密模式加锁、恢复与纠偏 API 调用的按群串行 Promise 链。
 * 填充：lockdownApiRunner 排入任务时建链；清理：链排空后自动删键，Worker 停止时丢弃；重建：Worker 重启后从空表开始；容量：不超过受管群数。
 */
export const lockdownApiChains: Map<number, Promise<void>> = new Map();

/** 私密模式 Telegram API 的按群串行调度器，绑定 lockdownApiChains，Worker 重启后重建。 */
export const lockdownApiRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(lockdownApiChains);

/**
 * 本 Worker 最近分配的私密模式意图 ID（单调递增）。
 * 填充：分配新意图时更新；清理与重建：Worker 重启后从零开始并以当前时间戳抬高；容量：固定为单个数值 holder。
 */
export const lastLockdownIntentId: { current: number } = { current: 0 };
