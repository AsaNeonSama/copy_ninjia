import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import { commandArgumentTokens } from "./arguments";
import type { CommandContext, Context } from "grammy";
import { BATCH_KICK_CONCURRENCY, BATCH_KICK_MAX_DURATION_MS, BATCH_KICK_MIN_DURATION_MS } from "../consts/commands";
import { TELEGRAM_DATE_UNIT_MS } from "../consts/telegram";
import { formatDurationCn, parseDurationTokenMs } from "../libs/durationToken";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { isUserBlocked } from "../infra/blocklist/membership";
import { requestBlocklistResweep, sweepBlockedMembers } from "../infra/blocklist/sweep";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import { readJoinLog } from "../infra/diskIO";
import { currentUpdateAbortSignal, throwIfUpdateAborted } from "../infra/updateContext";
import { batchKickChats } from "../cache/main/batchKick";
import {
  beginBatchKickExecution,
  beginBatchKickPreflight,
  endBatchKickExecution,
  endBatchKickPreflight,
  hasLiveBatchKickPreflight,
  isBatchKickChatManaged,
  isBatchKickTaskLive,
  purgeBatchKickChatState,
} from "./batchKick/preflight";
import { logger } from "../infra/logger";
import { readIdentityPolicyVerdicts } from "../infra/identityStorage";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../consts/identityStorage";
import type { BanChatMemberOutcome, KickChatMemberOutcome } from "../infra/telegram";
import {
  banChatMemberWithOutcome,
  kickChatMemberWithOutcome,
  probeChatMembership,
  replyCommandNotice,
  sendCommandMessage,
} from "../infra/telegram";
import type { BatchKickStats } from "../types/batchKick";
import type { JoinLogRecord } from "../types/diskIO/storage";
import { runBoundedSettledBatch } from "../libs/boundedSettledBatch";
import type { BoundedBatchExecution, BoundedBatchResult } from "../libs/boundedSettledBatch";
import { rejectUnlessSuperAdmin } from "./commandActor";
import { submitDeferredCommand } from "./deferredCommands";
import type { CachedUser } from "../types/chatState";
import type { IdentityPolicyVerdicts } from "../types/identityStorage";
import type { BatchKickTriggerSource } from "../types/miniApp/chats";

export type { BatchKickStats } from "../types/batchKick";

registerChatTeardown("batchKick", purgeBatchKickChatState);

/**
 * 把 `/batch_kick` 的单个 m/h/d 参数换算为毫秒数；须落在 BATCH_KICK_MIN_DURATION_MS 与 BATCH_KICK_MAX_DURATION_MS 之间，否则返回 undefined。
 * @param token 原始时长参数字符串（如 `"30m"`、`"2h"`）。
 * @returns 合法区间内的毫秒数；形态非法或越界时返回 undefined。
 */
export function parseBatchKickDurationMs(token: string): number | undefined {
  const durationMs: number | undefined = parseDurationTokenMs(token);
  if (
    durationMs === undefined ||
    durationMs < BATCH_KICK_MIN_DURATION_MS ||
    durationMs > BATCH_KICK_MAX_DURATION_MS
  ) {
    return undefined;
  }
  return durationMs;
}

/** 单条入群日志记录的批踢处置参数。 */
interface ProcessJoinRecordParams {
  /** 目标超级群 ID。 */
  chatId: number;
  /** 本批次登记的生命周期序号。 */
  taskSeq: number;
  /** 当前任务的停机取消信号。 */
  updateSignal: AbortSignal | undefined;
  /** 单条入群日志记录。 */
  record: JoinLogRecord;
  /** 本批次共享的可变统计计数器。 */
  stats: BatchKickStats;
  /** 本块开始前直接冷读的永久策略结论；与实时缓存取并集判定是否跳过。 */
  verdicts: IdentityPolicyVerdicts;
}

/**
 * 处理单条日志：先确认仍在群（probeChatMembership），再调用只踢不封接口；
 * 顺序固定，`unbanChatMember` 对已封禁身份有解除封禁语义。
 * @param params 目标群 `chatId`、批次序号 `taskSeq`、取消信号 `updateSignal`、入群记录 `record`、可变统计 `stats` 与本块永久策略结论 `verdicts`。
 */
async function processJoinRecord({
  chatId,
  taskSeq,
  updateSignal,
  record,
  stats,
  verdicts,
}: ProcessJoinRecordParams): Promise<void> {
  // isWhitelisted 已经把超级管理员算进白名单边界（infra/identityPolicy/whitelist.ts）。
  if (verdicts.whitelisted.has(record.userId) || isWhitelisted(record.userId)) {
    stats.protected++;
    return;
  }
  if (verdicts.blocked.has(record.userId) || isUserBlocked(record.userId)) {
    stats.blocked++;
    stats.blockedHandoffs++;
    return;
  }
  const present: boolean | undefined = await probeChatMembership(
    chatId,
    record.userId
  );
  if (updateSignal?.aborted === true || !isBatchKickTaskLive(chatId, taskSeq)) return;
  if (present === false) {
    stats.absent++;
    return;
  }
  if (present === undefined) {
    stats.failed++;
    return;
  }
  // membership 探测与只踢请求之间可能并发执行 `/block`：这里做第二次同步判定，
  // 请求完成后再判一次并补封，先写内存名单的永久封禁最终生效。
  if (isUserBlocked(record.userId)) {
    stats.blocked++;
    stats.blockedHandoffs++;
    return;
  }
  // 群内命令与 Mini App API 两个入口均只放行已确认的超级群（见 handleBatchKickCommand 与 triggerManagedChatBatchKick），isSupergroup 传 true。
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId: record.userId,
    isSupergroup: true,
  });
  // 网络失败也可能发生在 Telegram 已执行 unban 之后；只要权威名单已变为 blocked，
  // 不论 outcome 都补封。
  if (isUserBlocked(record.userId)) {
    const restored: BanChatMemberOutcome = await banChatMemberWithOutcome(
      chatId,
      record.userId
    );
    if (restored === "banned") {
      stats.blocked++;
      return;
    }
    requestBlocklistResweep(chatId);
    try {
      await sweepBlockedMembers(chatId);
    } catch (error: unknown) {
      // durable outbox 已经保留重放依据；命令战报仍按失败结算并留下原因。
      logger.error(
        `Failed to dispatch the blocklist repair after /batch_kick in chat ${chatId}:`,
        error
      );
    }
    stats.failed++;
    return;
  }
  if (outcome === "kicked") {
    stats.kicked++;
  } else if (outcome === "absent") {
    stats.absent++;
  } else if (outcome === "forbidden") {
    stats.forbidden++;
  } else {
    stats.failed++;
  }
}

/** 分块并发执行 `/batch_kick` 入群记录处置的参数。 */
interface RunBatchKickParams {
  /** 目标超级群 ID。 */
  chatId: number;
  /** 本批次登记的生命周期序号。 */
  taskSeq: number;
  /** 窗口内读取到的入群日志记录列表。 */
  records: readonly JoinLogRecord[];
}

/**
 * 按 BATCH_KICK_CONCURRENCY 并发消费日志，每块 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES 条；
 * 每条结果保留输入下标，意外异常不截断其余记录。429 退避由 Telegram 总闸负责，
 * 这里不重试。
 *
 * 每块开始前经 readIdentityPolicyVerdicts 直接读取本块全部身份的永久策略结论并局部
 * 持有，与消费逐块交错；白名单与黑名单判定取「局部结论 ∪ 实时缓存」。读取失败
 * （返回 null）时就地中断并置 aborted，剩余记录不处理。
 *
 * 停机取消本条任务后，尚未开始的记录不再处理，在途记录因取消而失败的结果不计入
 * 战报也不记日志；每块开始前与结束后各检查一次，取消即向上解开整条任务。本群途中
 * 不再受管或跨 `/init` 生命周期时同样不再处理尚未开始的记录，标记 `unmanaged` 后返回。
 * @param params 目标超级群 `chatId`、批次序号 `taskSeq` 与时间窗口内的入群日志记录列表 `records`。
 * @returns 批次处置完成或中断时的统计结果。
 */
async function runBatchKick({
  chatId,
  taskSeq,
  records,
}: RunBatchKickParams): Promise<BatchKickStats> {
  const stats: BatchKickStats = {
    kicked: 0,
    absent: 0,
    protected: 0,
    blocked: 0,
    forbidden: 0,
    failed: 0,
    blockedHandoffs: 0,
    scanned: 0,
    aborted: false,
    unmanaged: false,
  };
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  throwIfUpdateAborted(updateSignal);
  if (!isBatchKickTaskLive(chatId, taskSeq)) {
    stats.unmanaged = true;
    return stats;
  }
  for (
    let offset: number = 0;
    offset < records.length;
    offset += IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
  ) {
    throwIfUpdateAborted(updateSignal);
    if (!isBatchKickTaskLive(chatId, taskSeq)) {
      stats.unmanaged = true;
      return stats;
    }
    const chunk: readonly JoinLogRecord[] = records.slice(
      offset,
      offset + IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES
    );
    const verdicts: IdentityPolicyVerdicts | null = await readIdentityPolicyVerdicts(
      chunk.map((record: JoinLogRecord): number => record.userId)
    );
    if (verdicts === null) {
      stats.aborted = true;
      return stats;
    }
    const results: BoundedBatchResult<JoinLogRecord, void>[] =
      await runBoundedSettledBatch<JoinLogRecord, void>({
        items: chunk,
        maxConcurrent: BATCH_KICK_CONCURRENCY,
        execute: async ({
          item: record,
        }: BoundedBatchExecution<JoinLogRecord>): Promise<void> => {
          if (updateSignal?.aborted === true || !isBatchKickTaskLive(chatId, taskSeq)) return;
          await processJoinRecord({ chatId, taskSeq, updateSignal, record, stats, verdicts });
        },
      });
    throwIfUpdateAborted(updateSignal);
    if (!isBatchKickTaskLive(chatId, taskSeq)) {
      stats.unmanaged = true;
      return stats;
    }
    stats.scanned += chunk.length;
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      stats.failed++;
      logger.error(
        `Unexpected /batch_kick failure for chat ${chatId}, user ${result.item.userId}, ` +
        `record ${offset + result.index}:`,
        result.reason
      );
    }
  }
  return stats;
}

/** 后台延迟命令执行器中运行 `/batch_kick` 批次处置与战报发送的参数。 */
interface DeliverBatchKickParams {
  /** 目标超级群 ID。 */
  readonly chatId: number;
  /** 本批次登记的生命周期序号。 */
  readonly taskSeq: number;
  /** 触发来源：群内 `/batch_kick` 命令或 Mini App API。 */
  readonly source: BatchKickTriggerSource;
  /** 触发命令的消息 ID；用于挂回复引用。 */
  readonly messageId: number | undefined;
  /** 回溯时间窗口时长（毫秒）。 */
  readonly durationMs: number;
  /** 窗口内读取到的入群日志记录列表。 */
  readonly records: readonly JoinLogRecord[];
  /** 「已受理」回执发完（或发送结束）后兑现；批次在它之后开始，保证战报排在回执之后。 */
  readonly acknowledged: Promise<void>;
  /** 当 `source === "api"` 时在批次执行完成后写入服务端完成状态的回调。 */
  readonly onComplete?: (stats: Readonly<BatchKickStats>) => void;
}

/**
 * 延迟命令执行器里的批次任务：逐条处置、交回黑名单、按 NOTICE_TEXTS.batchKickResult 发战报。
 * 本群途中不再受管或跨 `/init` 生命周期时静默结束，不发战报；停机取消由执行器吞掉。结束时摘除单飞标记与批次序号，
 * 并仅在 `source === "api"` 且批次序号未被删数据类 teardown 作废时触发完成回调同步服务端状态。
 * @param params 目标群 `chatId`、批次序号 `taskSeq`、来源 `source`、触发消息 ID `messageId`、窗口时长 `durationMs`、入群记录 `records`、回执信号 `acknowledged` 及完成回调。
 */
async function deliverBatchKick({
  chatId,
  taskSeq,
  source,
  messageId,
  durationMs,
  records,
  acknowledged,
  onComplete,
}: DeliverBatchKickParams): Promise<void> {
  let completedStats: BatchKickStats | null = null;
  try {
    await acknowledged;
    const stats: BatchKickStats = await runBatchKick({ chatId, taskSeq, records });
    completedStats = stats;
    if (stats.unmanaged || !isBatchKickTaskLive(chatId, taskSeq)) {
      stats.unmanaged = true;
      return;
    }
    if (stats.aborted && stats.scanned === 0) {
      await sendCommandMessage({
        chatId,
        text: chatAtmosphere().IDENTITY_POLICY_UNAVAILABLE_TEXT,
        replyToMessageId: messageId,
      });
      return;
    }
    // processJoinRecord 对命中黑名单的记录直接返回，不探测、不移除；回执渲染成
    // 「黑名单交回封禁」，这里把它们真正交回：整批只派发一次补扫
    // （requestBlocklistResweep + sweepBlockedMembers）。只看 blockedHandoffs，
    // 并发拉黑后补封成功的记录不触发。
    if (stats.blockedHandoffs > 0) {
      requestBlocklistResweep(chatId);
      try {
        await sweepBlockedMembers(chatId);
      } catch (error: unknown) {
        // durable outbox 已经保留重放依据；战报照常发出，原因留在日志里。
        logger.error(
          `Failed to dispatch the blocklist sweep after /batch_kick in chat ${chatId}:`,
          error
        );
      }
    }
    throwIfUpdateAborted();
    if (!isBatchKickTaskLive(chatId, taskSeq)) {
      stats.unmanaged = true;
      return;
    }
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    await sendCommandMessage({
      chatId,
      text:
        atmosphere.NOTICE_TEXTS.batchKickResult({ duration: formatDurationCn(durationMs), recordCount: records.length, scanned: stats.scanned, kicked: stats.kicked, absent: stats.absent, protected: stats.protected, blocked: stats.blocked, forbidden: stats.forbidden, failed: stats.failed, abortedNotice: (stats.aborted
          ? atmosphere.NOTICE_TEXTS.batchKickAborted
          : "") }),
      replyToMessageId: messageId,
    });
  } finally {
    batchKickChats.delete(chatId);
    const liveExecution: boolean = endBatchKickExecution(chatId, taskSeq);
    if (source === "api" && liveExecution && completedStats !== null) {
      onComplete?.(completedStats);
    }
  }
}

/** 启动后台 `/batch_kick` 延迟任务的参数。 */
export interface StartBatchKickTaskParams {
  /** 目标超级群 ID。 */
  readonly chatId: number;
  /** 触发来源：`"command"`（群内 `/batch_kick` 命令）或 `"api"`（Mini App API）。 */
  readonly source: BatchKickTriggerSource;
  /** 触发命令的消息 ID；Mini App 触发时为 undefined。 */
  readonly messageId?: number;
  /** 回溯时间窗口时长（毫秒）。 */
  readonly durationMs: number;
  /** 窗口内读取到的入群日志记录列表。 */
  readonly records: readonly JoinLogRecord[];
  /** 受理回执完成信号；省略时立即开始处置。 */
  readonly acknowledged?: Promise<void>;
  /** 仅当 `source === "api"` 时生效的执行完成回调。 */
  readonly onComplete?: (stats: Readonly<BatchKickStats>) => void;
}

/**
 * 登记本群 `/batch_kick` 单飞状态与生命周期序号，并将批次任务提交至延迟命令执行器 background 档。
 * @param params 目标群 ID、触发来源、窗口时长、入群记录列表及可选回复消息 ID、回执同步信号与完成回调。
 * @returns 已由延迟命令执行器受理时返回 true；已有同群批次在途或队列满被拒时返回 false。
 */
export function startBatchKickTask({
  chatId,
  source,
  messageId,
  durationMs,
  records,
  acknowledged = Promise.resolve(),
  onComplete,
}: StartBatchKickTaskParams): boolean {
  if (batchKickChats.has(chatId)) return false;
  // 先登记再提交：执行器可能在提交的同步段里就启动任务。
  batchKickChats.add(chatId);
  const taskSeq: number = beginBatchKickExecution(chatId);
  const accepted: boolean = submitDeferredCommand({
    priority: "background",
    task: (): Promise<void> =>
      deliverBatchKick({ chatId, taskSeq, source, messageId, durationMs, records, acknowledged, onComplete }),
    errorLabel: "Unexpected error while processing /batch_kick:",
    onSkipped: (): void => {
      batchKickChats.delete(chatId);
      endBatchKickExecution(chatId, taskSeq);
    },
  });
  if (!accepted) {
    batchKickChats.delete(chatId);
    endBatchKickExecution(chatId, taskSeq);
    return false;
  }
  return true;
}

/**
 * `/batch_kick <Nm|Nh|Nd>`：只允许超级管理员在超级群中执行；初始化状态由
 * app/updatePreamble.ts 前置链的初始化网关保证，本 handler 不重复判断或提示。
 * 按需读取本群入群追写日志中回溯窗口覆盖的记录，并踢出窗口内仍在群的人。
 * 本命令不新增黑名单持久化；与并发 `/block` 冲突、或日志里的人本来就在黑名单上
 * 时，本命令不自己处置，而是在整批结束后请一次补扫，把他们真正交回封禁流程。
 *
 * handler 只做校验与读日志：有记录时同群单飞，交给延迟命令执行器的 background 档后
 * 回「已受理」，批次与战报在后台任务里完成（见 deliverBatchKick）。
 * @param ctx grammY 命令上下文。
 */
export async function handleBatchKickCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessSuperAdmin(
    ctx,
    (_actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.batchKickRejected
  );
  if (actor === undefined) return;
  if (ctx.chat.type !== "supergroup") {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickSupergroupOnly);
    return;
  }
  const tokens: string[] = commandArgumentTokens(ctx.match);
  const durationMs: number | undefined = tokens.length === 1
    ? parseBatchKickDurationMs(tokens[0]!)
    : undefined;
  if (durationMs === undefined) {
    await replyCommandNotice(ctx, chatAtmosphere().BATCH_KICK_USAGE_TEXT);
    return;
  }

  // 同群单飞在读日志之前判定：上一批还在后台跑时不读盘。
  if (batchKickChats.has(chatId)) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickRunning);
    return;
  }

  // 窗口的「现在」取本条命令自带的 Telegram 时间戳，与 joinedAt（来自 `update.date`，
  // 见 antiRaid/updateIngress.ts）同源；`readJoinLog` 用 since/now 比对 joinedAt，
  // 并据此计算窗口覆盖的日文件。文件保留期按宿主时钟判（见 readJoinLog 里的 today），与事件时间无关。
  const preflightSeq: number = beginBatchKickPreflight(chatId);
  const now: number = ctx.msg.date * TELEGRAM_DATE_UNIT_MS;
  let records: readonly JoinLogRecord[];
  try {
    records = await readJoinLog({ chatId, since: now - durationMs, now });
  } catch (error: unknown) {
    const live: boolean = hasLiveBatchKickPreflight(chatId, preflightSeq);
    endBatchKickPreflight(chatId, preflightSeq);
    if (!live || !isBatchKickChatManaged(chatId)) return;
    logger.error(`Failed to read join logs for /batch_kick in chat ${chatId}:`, error);
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.joinLogUnavailable);
    return;
  }
  const live: boolean = hasLiveBatchKickPreflight(chatId, preflightSeq);
  endBatchKickPreflight(chatId, preflightSeq);
  if (!live || !isBatchKickChatManaged(chatId)) return;
  if (batchKickChats.has(chatId)) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickRunning);
    return;
  }

  if (records.length === 0) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickEmpty(formatDurationCn(durationMs)));
    return;
  }

  const acknowledged: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  if (
    !startBatchKickTask({
      chatId,
      source: "command",
      messageId,
      durationMs,
      records,
      acknowledged: acknowledged.promise,
    })
  ) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickBusy);
    return;
  }
  try {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.batchKickAccepted({
      duration: formatDurationCn(durationMs),
      recordCount: records.length,
    }));
  } finally {
    acknowledged.resolve();
  }
}
