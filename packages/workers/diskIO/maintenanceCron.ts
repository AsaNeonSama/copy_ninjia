/** Disk I/O Worker 每日维护 cron 的注册、替换与停止边界。 */

import { diskIOMaintenanceCron } from
  "../../cache/workers/diskIO/maintenance";
import {
  DISK_IO_MAINTENANCE_CRON,
} from "../../consts/diskIO/maintenance";
import { runDiskIOMidnightMaintenance } from "./midnightMaintenance";
import { enqueueDiskIOOperation } from "./operationQueue";
import { getTimeZone } from "../../config/time";
import type { DiskIOMaintenanceReplySink } from "./midnightMaintenance";

/** 停止并清空当前维护 cron；未注册时幂等。 */
export function stopDiskIOMaintenanceCron(): void {
  if (diskIOMaintenanceCron.current === null) return;
  diskIOMaintenanceCron.current.stop();
  diskIOMaintenanceCron.current = null;
}

/**
 * 注册或替换配置时区午夜维护 cron（已 unref）。
 * @param reply 午夜维护向主线程发送回执的回调。
 */
export function registerDiskIOMaintenanceCron(
  reply: DiskIOMaintenanceReplySink
): void {
  stopDiskIOMaintenanceCron();
  diskIOMaintenanceCron.current = Bun.cron(
    DISK_IO_MAINTENANCE_CRON,
    (): void => {
      void enqueueDiskIOOperation(
        async (): Promise<void> => runDiskIOMidnightMaintenance(reply)
      );
    },
    { tz: getTimeZone() }
  ).unref();
}
