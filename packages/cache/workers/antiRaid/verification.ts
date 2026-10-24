/** owner: workers/antiRaid。入群验证状态机运行态（packages/workers/antiRaid/verificationRuntime.ts）。 */

import { VERIFICATION_REVISION_CAPACITY, VERIFICATION_REVISION_RETENTION_MS } from "../../../consts/antiRaid/verification";
import type {
  ReminderDelivery,
  ThreadCommentConfirmation,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { DeferredVerificationRecord } from
  "../../../types/antiRaid/verification";

/**
 * `chatId:userId` -> 入群验证状态机运行态条目。
 * 填充：状态机转移至非 ABSENT 状态或收到 adoptVerifications 接管时写入。
 * 清理：转移回 ABSENT（验证通过、离群、终态结算、守卫关闭）时按 key 删除，adopt 换代际时清空重建。
 * 重建：Worker 崩溃重启后由主线程发送 adoptVerifications 全量重放（states/verification/adopt.ts）。
 * 容量：上限为 VERIFICATION_RUNTIME_CAPACITY（持久阶段另受 VERIFICATION_RECORD_CAPACITY 约束），满载时拒收新 key 并触发 fatal，不淘汰持久责任。
 */
export const verificationEntries: Map<string, VerificationEntry> = new Map();

/**
 * 运行态容量超限拒收闩锁；首次超限置 true 并上报 fatal，仅在下一代 adopt 或 Worker 停止时复位，Worker 重启后为 false。容量固定为单个布尔值。
 */
export const verificationRuntimeCapacityFatalState: { current: boolean } = { current: false };

/**
 * 当前主线程分配的验证代际编号；零表示尚未收到 adoptVerifications。
 * 填充：收到主线程 `adoptVerifications` 时覆写为最新代际号；清理：Worker 停止时随进程销毁；重建：Worker 崩溃重启后初始为 0 并由主线程重放恢复；容量：固定单个数值。
 */
export const verificationGeneration: { current: number } = { current: 0 };

/**
 * `chatId:userId` -> 当前代际内最后使用的修订号及终结时刻。
 * 填充：发布快照或接管 adopt 记录时写入。
 * 清理：终结项由 sweepVerificationRevisionCache 按 VERIFICATION_REVISION_RETENTION_MS 回收，adopt 换代际时清空。
 * 重建：Worker 崩溃重启后由主线程重放活跃与延后记录重建。
 * 容量：上限为 VERIFICATION_REVISION_CAPACITY，满载时拒收新 key 并上报 fatal，未过期墓碑不淘汰。
 */
export const verificationRevisions: Map<string, { revision: number; retiredAt?: number }> = new Map();

/** 修订号容量超限 fatal 闩锁；每代际至多触发一次，换代际或停止时复位。容量固定为单个布尔值。 */
export const verificationRevisionCapacityFatalState: { current: boolean } = { current: false };

/**
 * 检查是否允许接纳新的验证修订号键；满载时先内联清理过期墓碑。
 *
 * @param key 验证记录键（`chatId:userId`）
 * @returns 是否允许接纳该验证修订号键
 */
export function canAdmitVerificationRevision(key: string): boolean {
  if (verificationRevisions.size < VERIFICATION_REVISION_CAPACITY) return true;
  if (verificationRevisions.has(key)) return true;
  sweepVerificationRevisionCache();
  return verificationRevisions.size < VERIFICATION_REVISION_CAPACITY;
}

/**
 * `chatId:userId` -> 验证预算耗尽后的进程内延后记录镜像。
 * 权威线程为主线程；在 adoptVerifications 时全量推送或在本地预算耗尽时写入。
 * 清理：成员离群、功能关闭、群停管、adoptVerifications 推进代际或 Worker 停止时删除或清空。
 * 重建与重放：Worker 崩溃重启后由主线程全量重放；无条目表示未接管该延后闩锁，不沿用旧代际结论。
 * 容量：与主线程延后索引同界。
 */
export const deferredVerificationRecords: Map<string, DeferredVerificationRecord> =
  new Map();

/**
 * `chatId:userId` -> 冷缓存楼中楼消息的在途关联频道确认任务。
 * 填充：发起确认时登记；清理：请求结算、群停用、adopt 或 Worker 停止时删除；重建：Worker 重启后从空表开始；容量：上限为 THREAD_COMMENT_CONFIRMATION_MAX，满载时拒收新请求。
 */
export const threadCommentConfirmations: Map<string, ThreadCommentConfirmation> =
  new Map();

/**
 * `chatId:userId` -> pending 成员的提醒消息在途发送状态。
 * 填充：发起提醒发送时登记；清理：状态转移、发送完成、群停用、adopt 或 Worker 停止时删除；重建：Worker 重启后由持久化 pending 快照重新安排；容量：verificationEntries 中 pending 成员的子集。
 */
export const reminderDeliveries: Map<string, ReminderDelivery> = new Map();

/**
 * 清理已超过 VERIFICATION_REVISION_RETENTION_MS 保留期的终结修订号墓碑。
 *
 * @param now 当前毫秒时间戳
 * @returns 本次清理删除的过期墓碑条数
 */
export function sweepVerificationRevisionCache(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const [key, revision] of verificationRevisions) {
    if (revision.retiredAt !== undefined && now - revision.retiredAt > VERIFICATION_REVISION_RETENTION_MS) {
      verificationRevisions.delete(key);
      deleted++;
    }
  }
  return deleted;
}
