import { logger } from "../../infra/logger";
import { resampleAiText } from "../../aiChat/ai/utils/resample";
import { BoundedDeque } from "../../libs/boundedDeque";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { formatBufferedMessageLine } from "../../aiChat/ai/utils/chatTranscript";
import { summaryAiProvider } from "../../aiChat/provider";
import {
  COMPACTION_MAX_PENDING_PER_CHAT,
  MAX_SUMMARY_ROUNDS,
  CHAT_SUMMARY_ERROR_LABEL,
  SUMMARY_MAX_CHARS,
  SUMMARY_RETRY_DELAYS_MS,
} from "../../consts/aiChat/memory";
import { CURRENT_TIME_LABEL, SUMMARY_SYSTEM_PROMPT, summarySelfNote } from "../../consts/aiChat/prompts/memory";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { chatSummaries, dirtyMemoryChats, pendingSummaries } from "../../cache/workers/aiChat/memory";
import { compactionPendingCounts, compactionRunner } from "../../cache/workers/aiChat/compaction";
import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
} from "../../cache/workers/aiChat/replies";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiTextResult } from "../../types/aiChat/provider";
import { currentTimeSentence } from "../../aiChat/ai/timeSentence";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";

/** 中期记忆轮换与压缩：镜像块攒满后按群串行执行旧摘要晋升与新镜像压缩。 */

/**
 * 将一轮「晋升旧摘要 + 压缩新镜像」排入该群的轮换串行链；积压达到 COMPACTION_MAX_PENDING_PER_CHAT
 * 时丢弃当前批次并记录错误日志。
 */
export function scheduleRotation(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): void {
  const generation: number = cachedReplyGeneration(chatId);
  const pendingCount: number = compactionPendingCounts.get(chatId) ?? 0;
  if (pendingCount >= COMPACTION_MAX_PENDING_PER_CHAT) {
    logger.error(
      `AI compaction backlog reached ${COMPACTION_MAX_PENDING_PER_CHAT} tasks for chat ${chatId}; ` +
      `dropping one ${mirrorBatch.length}-message batch to keep memory bounded.`
    );
    return;
  }

  const signal: AbortSignal = replyGenerationSignal(generation);
  compactionPendingCounts.set(chatId, pendingCount + 1);
  const next: Promise<void> = compactionRunner.run(chatId, (): Promise<void> => rotateCompaction({
    chatId,
    mirrorBatch,
    promoteFirst,
    generation,
    signal,
  }));
  trackReplyGenerationTask(chatId, generation, next);
  void next.then(
    (): void => finishCompactionTask(chatId),
    (): void => finishCompactionTask(chatId)
  );
}

/** 轮换任务结束后递减该群待处理计数。 */
function finishCompactionTask(chatId: number): void {
  const remaining: number = Math.max(0, (compactionPendingCounts.get(chatId) ?? 1) - 1);
  if (remaining === 0) compactionPendingCounts.delete(chatId);
  else compactionPendingCounts.set(chatId, remaining);
}

export interface RotateCompactionParams {
  chatId: number;
  mirrorBatch: BufferedMessage[];
  promoteFirst: boolean;
  generation: number;
  signal: AbortSignal;
}

/** 执行单轮轮换：按需晋升上一轮待晋升摘要，再调用模型压缩新镜像批次并存入 pendingSummaries。 */
async function rotateCompaction({
  chatId,
  mirrorBatch,
  promoteFirst,
  generation,
  signal,
}: RotateCompactionParams): Promise<void> {
  try {
    if (signal.aborted || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await resampleAiText({
      label: `AI compaction for chat ${chatId}`,
      call: (): Promise<AiTextResult> => summarizeBatch(mirrorBatch, signal),
      delaysMs: SUMMARY_RETRY_DELAYS_MS,
      signal,
    });
    if (signal.aborted || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (summary) {
      pendingSummaries.set(chatId, summary);
      dirtyMemoryChats.add(chatId);
    } else {
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary after eligible retries; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    if (signal.aborted) return;
    logger.error("Error in chat compaction task:", error);
  }
}

/** 将上一轮待晋升摘要推入该群的中期记忆队列（上限 MAX_SUMMARY_ROUNDS）。 */
function promotePendingSummary(chatId: number): void {
  const pending: string | undefined = pendingSummaries.get(chatId);
  pendingSummaries.delete(chatId);
  if (!pending) return;
  let queue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  if (!queue) {
    queue = new BoundedDeque<string>(MAX_SUMMARY_ROUNDS);
    chatSummaries.set(chatId, queue);
  }
  if (queue.size === MAX_SUMMARY_ROUNDS) queue.shift();
  queue.push(pending);
  dirtyMemoryChats.add(chatId);
}

/** 调用 summary 能力模型将一批消息压缩为单行摘要，按子句边界截断到 SUMMARY_MAX_CHARS。 */
async function summarizeBatch(batch: BufferedMessage[], signal: AbortSignal): Promise<AiTextResult> {
  const selfId: number | undefined = botInfoState.current?.id;
  const selfNote: string = selfId !== undefined ? summarySelfNote(selfId) : "";
  return summaryAiProvider().generateText({
    purpose: "chatSummary",
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userContent: selfNote + batch.map((message: BufferedMessage): string => formatBufferedMessageLine(message, selfId)).join("\n") + "\n\n" + currentTimeSentence(CURRENT_TIME_LABEL),
    signal,
    errorLabel: CHAT_SUMMARY_ERROR_LABEL,
    normalize: (text: string): string => {
      const sanitized: string = sanitizeInline(text);
      return sanitized ? truncateAtClauseBoundary(sanitized, SUMMARY_MAX_CHARS) : "";
    },
  });
}
