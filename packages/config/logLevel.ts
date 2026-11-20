import { logLevelState } from "../cache/perThread/logger";
import type { LogLevel } from "../types/diskIO/messages";

/**
 * 应用已验证的日志级别阈值到当前线程状态；仅由启动配置初始化与 Worker 重放消息调用。
 * @param level 经严格校验的最低输出与持久化日志级别。
 */
export function adoptLogLevel(level: LogLevel): void {
  logLevelState.current = level;
}

/**
 * 读取当前线程生效的最低输出与持久化日志级别阈值。
 * @returns 当前线程生效的日志级别。
 */
export function getLogLevel(): LogLevel {
  return logLevelState.current;
}
