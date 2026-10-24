/**
 * 统一日志门面：所有级别经脱敏序列化后输出到控制台；`error` 级别在主线程经 `logRelaySink`
 * 送交 Disk I/O Worker 落盘，在业务 Worker 线程经 `ForwardedLogBatch` 有界单批 ACK 通道转发回主线程。
 */

import { logRelaySink } from "../cache/perThread/logger";
import { serializeLogArgs } from "./logger/serialization";
import {
  acceptForwardedLogBatch as acceptForwardedLogBatchInternal,
  forwardWorkerLog,
} from "./logger/forwarding";
import type { ForwardedLogSink } from "./logger/forwarding";
import type {
  ForwardedLogBatch,
  LogLevel,
  LogMessage,
} from "../types/diskIO/messages";

declare const self: Worker;

// 是否运行在主线程：决定 error 日志是直接转投落盘线程，还是包上信封向上
// 转发给拥有本 Worker 的主线程模块。
const isMainThread: boolean = Bun.isMainThread;

/**
 * Worker 侧转发出口。整条协议（有界队列、单批 ACK、溢出汇总）住在
 * infra/logger/forwarding.ts；这里只把它接到本 isolate 的 postMessage 上。
 * @param batch 待通过 `self.postMessage` 发往主线程的转发日志批次。
 */
const forwardToMainThread: ForwardedLogSink = (batch: ForwardedLogBatch): void => {
  self.postMessage(batch);
};

/**
 * 消费主线程发回的日志批次 ACK。返回 true 表示该消息属于 logger 协议，Worker
 * 入口不得再把它交给业务路由。
 * @param message Worker 收到的原始主线程消息。
 * @returns 消息属于日志批次 ACK 协议时返回 true，否则返回 false。
 */
export function acceptForwardedLogBatch(message: unknown): boolean {
  return acceptForwardedLogBatchInternal(message, forwardToMainThread);
}

/**
 * 脱敏序列化日志参数后输出到控制台，并在 `error` 级别下投递或转发持久化。
 * @param level 日志级别。
 * @param args 原始日志参数列表。
 */
function emit(level: LogLevel, args: unknown[]): void {
  // 序列化边界统一处理异常对象、不可序列化值与敏感字段。
  const serializedArgs: unknown[] = serializeLogArgs(args);
  // 所有控制台级别统一输出脱敏后的参数。
  try {
    console[level](...serializedArgs);
  } catch {
    // console 抛错时忽略，emit 不向调用方抛出。
  }
  if (level !== "error") return;
  const message: LogMessage = {
    timestamp: Date.now(),
    level,
    args: serializedArgs,
  };
  if (isMainThread) {
    logRelaySink.current?.(message);
  } else {
    // 转发模式：先进入单批 ACK、有界待发送 FIFO，再由主线程转投落盘线程。
    forwardWorkerLog(message, forwardToMainThread);
  }
}

/** 主线程与 Worker 共用的日志出口；Worker 侧经 postMessage 转发到主线程。 */
interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export const logger: Logger = {
  log: (...args: unknown[]): void => emit("log", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
