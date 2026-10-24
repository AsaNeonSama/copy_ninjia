/**
 * Disk I/O Worker 的逐领域维护编排：启动（diskIO/startup.ts）与配置时区的午夜维护共用
 * runDiskIOMaintenanceTasks，逐领域执行并隔离失败。
 */

import { maintainAdSampleFiles } from "./adSampleFile";
import { summarizeAiCache } from "./aiCacheFile";
import { maintainJoinLogRetention } from "./joinLogFiles";
import { maintainLogRetention } from "./logFiles";
import { maintainLuckForDay } from "./luckFiles";
import { maintainTemporaryAdBypassActivities } from "./storageDatabase";
import {
  maintainVerificationDayForToday,
} from "./verificationWrites";
import { getDateKey } from "../../libs/time";
import type {
  IdentityStoragePersistedReply,
  MidnightMaintenanceReply,
  VerificationPersistedReply,
} from
  "../../types/diskIO/replies";

/** 午夜维护共用的 Worker 回执出口。 */
export type DiskIOMaintenanceReplySink = (
  reply: IdentityStoragePersistedReply | VerificationPersistedReply | MidnightMaintenanceReply
) => void;

/** 一个领域的维护步骤：日志里的领域名与维护函数。 */
type DiskIOMaintenanceTask = readonly [string, () => void | Promise<void>];

/**
 * 逐领域串行执行维护步骤；单个领域抛错只记录错误并继续后续领域。
 * @param phase 维护触发阶段标识（启动或午夜）。
 * @param tasks 按顺序执行的 `[领域名, 维护回调]` 列表。
 */
export async function runDiskIOMaintenanceTasks(
  phase: "startup" | "midnight",
  tasks: readonly DiskIOMaintenanceTask[]
): Promise<void> {
  for (const [domain, maintain] of tasks) {
    try {
      await maintain();
    } catch (error: unknown) {
      console.error(`[diskIOWorker] ${phase} maintenance failed for ${domain}:`, error);
    }
  }
}

/**
 * 通知主线程触发日级维护后，依次执行各磁盘领域的午夜维护。
 * @param reply 向主线程发送午夜维护通知与持久化回执的回调。
 * @param day 目标维护日期键（`YYYY-MM-DD`）；缺省为当前时刻。
 */
export function runDiskIOMidnightMaintenance(
  reply: DiskIOMaintenanceReplySink,
  day: string = getDateKey()
): Promise<void> {
  return runDiskIOMaintenanceTasks("midnight", [
    ["main thread", (): void => reply({ type: "midnightMaintenance", day })],
    ["luck", async (): Promise<void> => maintainLuckForDay(day)],
    ["logs", async (): Promise<void> => maintainLogRetention()],
    ["ai cache", (): Promise<void> => summarizeAiCache(day)],
    ["join logs", async (): Promise<void> => maintainJoinLogRetention(day)],
    ["ad samples", (): Promise<void> => maintainAdSampleFiles(day)],
    ["verifications", (): Promise<void> => maintainVerificationDayForToday(reply, day)],
    ["temporary ad bypass", (): void => maintainTemporaryAdBypassActivities(reply)],
  ]);
}
