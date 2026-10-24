/** Linux 进程的稳定身份，用于防 PID 复用的实例锁。 */
export interface ProcessIdentity {
  /** 操作系统进程 ID。 */
  pid: number;
  /** `/proc/<pid>/stat` 中的进程启动时钟滴答数（第 22 字段）。 */
  startTimeTicks: string;
  /** `/proc/sys/kernel/random/boot_id` 中的内核启动周期 UUID。 */
  bootId: string;
}
