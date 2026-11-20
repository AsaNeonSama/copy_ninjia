/** Linux 进程的稳定身份，用于防 PID 复用的实例锁。 */
export interface ProcessIdentity {
  /** 操作系统进程 ID。 */
  pid: number;
  /** `/proc/<pid>/stat` 中的进程启动时钟滴答数（第 22 字段）。 */
  startTimeTicks: string;
  /** `/proc/sys/kernel/random/boot_id` 中的内核启动周期 UUID。 */
  bootId: string;
}

/** `libs/atomicFile.ts` 解析 `.<file>.<pid>.<uuid><TMP_FILE_SUFFIX>` 临时文件名得到的字段。 */
export interface ParsedAtomicTempFileName {
  /** 去掉前导 `.` 与 `.<pid>.<uuid><TMP_FILE_SUFFIX>` 后缀后的原始目标文件名。 */
  readonly targetFileName: string;
  /** 文件名内记录的写入方进程 PID。 */
  readonly pid: number;
  /** 文件名内记录的 36 位 UUIDv1–v5 标识符。 */
  readonly uuid: string;
}
