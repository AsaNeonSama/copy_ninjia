/** owner: main。入群日志未确认落盘镜像与投递序号（packages/infra/joinLog.ts）。 */
import { LinkedQueue } from "../../libs/linkedQueue";
import type { JoinLogDiskMessage } from "../../types/diskIO/messages";

/**
 * 已投递给 Disk I/O Worker 但尚未收到 joinLogPersisted 回执的入群事实队列（按序号升序）：
 * - 镜像语义：权威处置线程为 Disk I/O Worker，在 flush、窗口外丢弃或整群删除后增量回执已接收最大序号与待写序号；Disk I/O Worker 重建时由 infra/joinLog.ts 的 replayJoinLogs 按原序全量重放；无条目表示无未确认入群事实。
 * - 填充与清理：recordJoinLog 投递成功后入队，收到回执或群 teardown 整群删除时移除；容量上限为 JOIN_LOG_MAX_BUFFERED_ENTRIES，满额拒绝新条目且不淘汰未确认事实；进程重启后从空队列开始。
 */
export const unacknowledgedJoinLogs: LinkedQueue<JoinLogDiskMessage> = new LinkedQueue();

/** 入群日志投递序号发号器：recordJoinLog 每次递增，Worker 重建不重置，进程重启后从零开始；单例标量。 */
export const joinLogSequence: { current: number } = { current: 0 };
