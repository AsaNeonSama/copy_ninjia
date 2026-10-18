import { STATE_MANAGED_CHAT_LIMIT } from "../storage";

/** 冷消息压缩请求在错误日志里的调用名；供应商中立，各家实现包共用。 */
export const CHAT_SUMMARY_ERROR_LABEL: string = "AI summarize API";

/** HTTP 成功但摘要正文不可用（Anthropic 拒答除外）时，两次业务重采样之间的退避。 */
export const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000];

/**
 * 单个压缩块的消息条数（热窗口与镜像窗口大小；逐字上下文上限见 VERBATIM_CONTEXT_MAX，
 * 轮换见 workers/aiChat/rollingMemory.ts 的 pushBufferedMessage 与 workers/aiChat/compaction.ts 的 scheduleRotation）。
 */
export const COMPACT_BATCH_SIZE: number = 128;
/** 模型请求中保留的逐字消息最大数量。 */
export const VERBATIM_CONTEXT_MAX: number = COMPACT_BATCH_SIZE * 2;
/**
 * 逐字转录分层边界的对齐粒度（条），必须整除 COMPACT_BATCH_SIZE。
 * 【较早逐字记录】的长度取本值的整数倍（见 aiChat/ai/utils/chatTranscript.ts 的 buildTieredVerbatimTranscript）。
 */
export const TIER_BOUNDARY_ALIGNMENT: number = 32;
/**
 * 转录已定切点的格宽（条），必须整除 TIER_BOUNDARY_ALIGNMENT（见 aiChat/ai/utils/chatTranscript.ts 的
 * RenderedTranscript.settledOffsets 与 aiChat/anthropic/replySession.ts）。
 */
export const TRANSCRIPT_SETTLED_SEGMENT_SIZE: number = 8;
/** 每群保留的冷摘要轮数。 */
export const MAX_SUMMARY_ROUNDS: number = 7;
/** 单群执行中 + 排队中的压缩任务硬顶。 */
export const COMPACTION_MAX_PENDING_PER_CHAT: number = 25;
/** dirty AI 记忆快照上报主线程的周期。 */
export const AI_SNAPSHOT_INTERVAL_MS: number = 30_000;
/** hydrate 恢复的逐字缓存消息上限，预留空间供下一次 push 命中轮换等值边界。 */
export const AI_MEMORY_HYDRATE_BUFFER_MAX: number = VERBATIM_CONTEXT_MAX - 1;
/**
 * Worker 常驻群记忆总上限，超额按最后活动时间淘汰。
 *
 * 取受管群数的倍数：AI 记忆只属于受管群（`chat_states.ai_context`），未完成的
 * teardown 最多 STATE_MANAGED_CHAT_LIMIT 项（见 aiChat/memoryMirror.ts 的
 * beginAiMemoryTeardown），旧群记忆可与同样多的新受管群短暂并存。取值不得低于
 * 这个和。
 */
export const AI_MEMORY_MAX_CHATS: number = 2 * STATE_MANAGED_CHAT_LIMIT;
/** 单条摘要硬性字符上限。 */
export const SUMMARY_MAX_CHARS: number = 500;
/** 回复引用保留的单行片段最大字符数，只保留足以辨认原消息的部分。 */
export const REPLY_REFERENCE_MAX_CHARS: number = 500;
