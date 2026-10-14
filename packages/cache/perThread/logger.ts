/** owner: perThread。日志转发队列、脱敏凭据快照与主线程日志转投出口（packages/infra/logger.ts）。 */

import {
  LOGGER_FORWARD_BATCH_MAX_MESSAGES,
  LOGGER_FORWARD_MAX_PENDING_MESSAGES,
  LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
} from "../../consts/logger";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import type { LogMessage } from "../../types/diskIO/messages";
import type { LoggerSecretsSnapshot } from "../../types/logger";

/**
 * 业务 Worker 转发给主线程的单批在途日志队列：Worker 内 logger.error 写入，收到主线程 __logBatchAccepted 回执后排空，isolate 销毁后随堆释放、重建后从空队列开始。
 * 容量上限为 LOGGER_FORWARD_MAX_PENDING_MESSAGES 条与 LOGGER_FORWARD_MAX_SERIALIZED_BYTES 字节（单批上限 LOGGER_FORWARD_BATCH_MAX_MESSAGES）；满额时丢弃新日志对象并累加到 forwardedLogDropState。
 */
export const forwardedLogQueue: AcknowledgedBatchQueue<LogMessage> =
  new AcknowledgedBatchQueue<LogMessage>({
    maxBatchMessages: LOGGER_FORWARD_BATCH_MAX_MESSAGES,
    maxMessages: LOGGER_FORWARD_MAX_PENDING_MESSAGES,
    maxCost: LOGGER_FORWARD_MAX_SERIALIZED_BYTES,
  });

/** 业务 Worker 日志转发队列满额时的累计丢弃条数与字节数：溢出时递增，腾出空间并成功补发汇总日志后清零，isolate 重建时归零；单例固定字段。 */
export const forwardedLogDropState: {
  current: {
    droppedMessages: number;
    droppedSerializedBytes: number;
  };
} = {
  current: {
    droppedMessages: 0,
    droppedSerializedBytes: 0,
  },
};

/**
 * 当前线程的日志凭据脱敏快照单例（infra/logger/serialization.ts 的 currentSecrets）：首次写日志或本线程任一配置 holder 引用变化时构造并整体替换（保留当前凭据与最近退役凭据，数组上限为 LOGGER_MAX_REDACTED_SECRETS，超限淘汰最早退役的旧凭据）。
 * 进程或 Worker 重建后从 null 重新按当前配置构造。
 */
export const loggerSecretsMemo: {
  current: LoggerSecretsSnapshot | null;
} = { current: null };

/** 主线程 error 日志转投 Disk I/O 的回调单例：initDiskIO 安装 relayLogMessage，Worker 线程保持为 null；不淘汰，进程重启后从 null 重新安装。 */
export const logRelaySink: { current: ((message: LogMessage) => boolean) | null } = { current: null };
