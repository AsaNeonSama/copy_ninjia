/** owner: workers/diskIO。每日维护 cron 句柄状态（packages/workers/diskIO/maintenanceCron.ts）。 */

/**
 * Disk I/O 每日维护 cron 任务句柄单例：启动恢复全部成功后创建并写入（同时 unref），重复注册或重新恢复时先停止旧句柄再替换，isolate 销毁时释放。
 * 单例对象，不淘汰；Worker 重建后在新 isolate 启动恢复成功时重新创建（null 表示当前未注册）。
 */
export const diskIOMaintenanceCron: {
  current: Bun.CronJob | null;
} = { current: null };
