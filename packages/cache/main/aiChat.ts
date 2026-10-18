/** owner: main。AI 闲聊主线程代理（packages/aiChat/）的内存状态。 */

import { ABUSE_MARK_MAX_USERS } from "../../consts/aiChat/rateLimit";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { FifoMap } from "../../libs/fifoMap";
import { createFlushBarrier } from "../../libs/flushBarrier";
import type { FlushBarrier } from "../../libs/flushBarrier";
import type { AiMemoryUsage } from "../../types/aiChat/memory";
import type { AiBotInfo, AiInitMessage } from "../../types/aiChat/protocol";
import type {
  AiMemoryDeleteWaiter,
  AiMemoryTeardown,
} from "../../types/aiChat/waiters";
import type { VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";
import type { WebDigestCompositionResult } from "../../types/webDigest";
import type { WorkerRequestOutcome, WorkerRequestTable } from "../../types/workerRequest";

/**
 * AI Worker 记忆回传 barrier。模块加载时创建，Worker 终止时统一结算等待者；
 * 进程重启后以空等待表重建，容量受并发 flush 数约束。
 */
export const aiMemoryFlushBarrier: FlushBarrier = createFlushBarrier({
  timeoutMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
});

/**
 * 最近一次注入 AI Worker 的 init 消息。startAiChatWorker 投递成功后写入，
 * syncAiChatConfig 热重载时改写，onGiveUp 清空；Worker 崩溃重建时由 onRespawn
 * 重放，进程重启后从 null 开始。容量恒为一个对象。
 */
export const lastInitState: { current: AiInitMessage | null } = { current: null };
/**
 * 机器人账号身份快照。启动时 initAiChat 写入一次；热重载使 AI 闲聊转为可用时由
 * aiChat/hydration.ts 的 resumeAiChat 读取以启动 Worker。运行期不清理，进程重启后从 null
 * 开始；主线程独占，Worker 崩溃不影响，容量恒为一个对象。
 */
export const aiChatBotInfo: { current: AiBotInfo | null } = { current: null };

/**
 * 各群最新 AI 记忆快照的只读镜像（JSON 文本，见 types/aiChat/protocol.ts 的 AiMemoryEvent）。
 *
 * 权威线程为 AI Worker；Worker 上报 memory 事件时按群增量覆盖，启动恢复时由
 * aiChat/hydration.ts 从磁盘快照全量播种。清理：aiChat/memoryMirror.ts 的
 * requestAiMemoryDelete 按群删除（`/clear_context`、`/ai_chat disable`、群 teardown 与
 * Worker 侧 LRU 淘汰）。重放方：AI Worker 崩溃重建时由 aiChat/workerBridge.ts 的 onRespawn
 * 全量 hydrate，Disk I/O Worker 崩溃重建时由 aiChat/memoryMirror.ts 重放。
 * 无条目表示该群当前无可重放记忆，不沿用旧值。容量上限为 AI_MEMORY_MAX_CHATS。
 */
export const latestAiMemories: Map<number, string> = new Map();
/**
 * 各群 AI 上下文占用量的只读镜像，供 `/bot_status` 读取。
 *
 * 权威线程为 AI Worker（cache/workers/aiChat/memory.ts 的 chatBuffers 与 chatSummaries）。
 * 推送时机与模式：AI Worker 上报 memory 事件时按群增量覆盖（间隔 AI_SNAPSHOT_INTERVAL_MS），
 * hydrate 完成后通过 memoryUsages 事件全量播种。重放方：AI Worker 崩溃重建后由
 * aiChat/workerBridge.ts 的 onRespawn 重放 hydrate，新 isolate 恢复后回传 memoryUsages。
 * 清理：随 requestAiMemoryDelete 与 latestAiMemories 同步按群删除。
 * 无条目表示该群当前没有可展示的上下文（含尚未收到首次上报），按空上下文展示，不沿用旧值。
 * 容量上限为 AI_MEMORY_MAX_CHATS。
 */
export const aiMemoryUsages: Map<number, AiMemoryUsage> = new Map();
/**
 * latestAiMemories 各快照对应的运行时 revision；启动恢复播种时写入初始基准值，
 * 此后随 memory 事件更新。清理、重放与容量同 latestAiMemories，两表成对增删。
 */
export const latestAiMemoryRevisions: Map<number, number> = new Map();
/**
 * 本进程内各群已分配的最高记忆 revision。
 *
 * 填充：启动恢复与 nextAiMemoryRevision 分配时写入。清理：群 teardown 的 durable 删除与
 * Worker 失效均完成后由 forgetAiMemoryRevisionCounter 删除；`/ai_chat disable` 不删除，
 * postMemoryRecord 据「计数器仍在」判定 purge 后首条新记录需即时落盘。
 * Worker 崩溃重建不影响本表，进程重启后从空表重建；不按容量淘汰，容量受
 * STATE_MANAGED_CHAT_LIMIT 与在途 teardown 数约束。
 */
export const aiMemoryRevisionCounters: Map<number, number> = new Map();
/** teardown 已释放计数器的最高 revision 下界；nextAiMemoryRevision 从不低于该下界处递增。进程重启后归零，Worker 重建保留，容量为一个标量。 */
export const aiMemoryRevisionFloor: { current: number } = { current: 0 };
/**
 * 在途的群记忆 teardown 状态。beginAiMemoryTeardown 登记，durable 删除与 Worker 失效均完成后
 * 由 finishAiMemoryTeardown 删除，新记录写入时撤销旧登记。主线程权威，容量上限为
 * STATE_MANAGED_CHAT_LIMIT，满额触发存储 fatal 并拒绝新增。AI Worker 重建直接结算 Worker 侧
 * 状态，Disk I/O Worker 重建重放待确认删除。无条目表示无在途 teardown，进程重启后从空表重建。
 */
export const pendingAiMemoryTeardowns: Map<number, AiMemoryTeardown> = new Map();
/**
 * 已投递但尚未收到 durable 回执的记忆删除墓碑（chatId -> revision）。
 *
 * 填充：requestAiMemoryDelete 投递删除时写入。清理：收到匹配 revision 的
 * aiMemoryDeletedPersisted 回执时删除。Disk I/O Worker 重建时由 onDiskIORespawn 全量重放。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰。
 */
export const pendingAiMemoryDeletes: Map<number, number> = new Map();
/**
 * purge 后首份新记忆的即时持久化追踪（null 表示已通知 AI Worker 待上报快照，number 表示已投递
 * Disk I/O 等待该 revision 的回执）。
 *
 * 填充：invalidateAiChat 完成 purge 时写入 null，收到首份 memory 事件时更新为 revision。
 * 清理：收到不低于该 revision 的 aiMemoryPersisted 回执、再次 purge 或 AI Worker 放弃自愈时删除。
 * AI Worker 与 Disk I/O Worker 重建时保留并继续走即时持久化路径。容量上界为 STATE_MANAGED_CHAT_LIMIT。
 */
export const postPurgeAiMemoryPersistRevisions: Map<number, number | null> = new Map();
/**
 * 显式删除记忆的等待者列表（LRU 淘汰删除不挂等待者）。
 * 填充：`/clear_context`、`/ai_chat disable` 与群 teardown 调用 requestAiMemoryDelete(chatId, true) 时登记。
 * 清理：收到 aiMemoryDeletedPersisted 回执、满 AI_MEMORY_FLUSH_TIMEOUT_MS 超时、投递被拒或
 * Disk I/O Worker 放弃自愈时结算并删除。容量上界为 STATE_MANAGED_CHAT_LIMIT。
 */
export const aiMemoryDeleteWaiters: Map<number, AiMemoryDeleteWaiter[]> = new Map();
/**
 * 已发出清除请求、尚待 AI Worker 回传 memoryDeleted 确认的群集合。
 *
 * 填充：invalidateAiChat 在 Worker 可用时加入。在此期间到达的该群 memory 事件直接丢弃并补发删除。
 * 清理：收到 memoryDeleted 事件、该群产生新记录（recordChatMessage / recordChatMedia），或
 * AI Worker 放弃自愈 / 终止时移除。容量上界为 STATE_MANAGED_CHAT_LIMIT。
 */
export const purgedAiMemoryChats: Set<number> = new Set();
/**
 * 心情查询与重抽请求等待表（发起方为 aiChat/workerBridge.ts 的 requestAiMood）。
 * 请求发出前登记；收到回执、超时、投递被拒或 AI Worker 崩溃重建 / 放弃 / 终止时结算并删除，
 * Worker 重建不重放。容量受并发 `/mood` 命令数约束；计数器进程重启后从初值重建。
 */
export const moodRequests: WorkerRequestTable<WorkerRequestOutcome<string>> = {
  waiters: new Map(),
  counter: { current: 0 },
};
/**
 * 语音合成请求等待表（见 aiChat/voiceSynthesis.ts）。发出 synthesizeVoice 前登记；
 * 收到回执、超时、调用方取消、投递被拒或 AI Worker 崩溃重建 / 放弃 / 终止时结算并删除，
 * Worker 重建不重放。容量受延迟命令执行器并发与 cron 在途轮数约束，不设淘汰。
 */
export const voiceSynthesisRequests: WorkerRequestTable<VoiceSynthesisResult> = {
  waiters: new Map(),
  counter: { current: 0 },
};
/**
 * 摘要组稿请求等待表（见 aiChat/webDigest.ts）。填充、清理与重建口径同 voiceSynthesisRequests；
 * 容量受 cron 在途轮数约束，不设淘汰。
 */
export const webDigestRequests: WorkerRequestTable<WebDigestCompositionResult> = {
  waiters: new Map(),
  counter: { current: 0 },
};
/**
 * 群失效（invalidateChat）请求等待表。请求发出前登记，requestId 同步记入 pendingAiMemoryTeardowns；
 * 收到 chatInvalidated 回执、超时、投递被拒或 AI Worker 崩溃重建 / 放弃 / 终止时结算并删除，
 * Worker 重建不重放。容量上界为 STATE_MANAGED_CHAT_LIMIT。
 */
export const aiChatInvalidateRequests: WorkerRequestTable<WorkerRequestOutcome<undefined>> = {
  waiters: new Map(),
  counter: { current: 0 },
};
/** AI Worker 可用标志。startAiChatWorker 成功后置 true，投递被拒、终止或放弃自愈时置 false；进程重启后从 false 开始，容量为一个布尔值。 */
export const aiChatWorkerState: { available: boolean } = { available: false };
/**
 * 主线程持有的贴纸目录快照只读镜像（pack -> JSON 文本）。
 *
 * 权威线程为 AI Worker（cache/workers/aiChat/stickers/catalog.ts）；AI Worker 生成目录后通过
 * stickerCatalog 事件按包增量推送，启动恢复时从磁盘快照全量播种。
 * 重放方：AI Worker 重建时由 onRespawn 重放当前白名单包，Disk I/O Worker 重建时由
 * aiChat/memoryMirror.ts 重放全表。清理：退出配置白名单的包在无待确认写入时由
 * pruneStickerCatalogMirror 删除，有待确认写入的包在收到匹配最新 revision 的
 * stickerCatalogPersisted 回执后删除。无条目表示该包无可重放目录，不沿用旧值。
 * 容量为当前配置白名单包与待确认落盘的旧包数。
 */
export const latestStickerCatalogs: Map<string, string> = new Map();

/**
 * 被 abuse_mark 工具标记的用户及其独立到期清理定时器（userId -> Timer）。
 *
 * 填充：主线程收到 AI Worker 的 abuseMark 事件时由 aiChat/abuseMark.ts 的 markAbuseUser 写入，
 * 每个条目持有独立的单次 setTimeout（unref）。清理：对应定时器满 ABUSE_MARK_DURATION_MS 到期时自动删除该键，
 * 重复标记同一用户时先 clearTimeout 并删除旧项再重建，满额淘汰或 terminateAiChat 时调用 clearTimeout 并移除。
 * 重建：AI Worker 崩溃重建时主线程保留当前未到期条目，进程重启后从空表开始。
 * 容量上限为 ABUSE_MARK_MAX_USERS，超出时经 FifoMap.oldestKey() 淘汰最早插入项并取消其定时器。
 */
export const abuseMarkedUsers: FifoMap<number, ReturnType<typeof setTimeout>> = new FifoMap(ABUSE_MARK_MAX_USERS);
