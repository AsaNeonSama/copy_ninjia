import { telegramSignal } from "../../../libs/telegramSignal";
import { isMessageDeletionSettled } from "../../../libs/messageDeletion";
import type { ReactionTypeEmoji } from "grammy/types";
import { telegramApi } from "../client";
import {
  inFlightMessageDeletions,
  pendingMessageDeletions,
} from "../../../cache/perThread/messageDeletion";
import { logger } from "../../logger";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../../../libs/monotonicDeadline";
import { trackBackgroundTask } from "../../backgroundTasks";
import { settleWithinBudget } from "../../../libs/inflight";
import {
  isPermissionDenied,
  runBooleanTelegramAction,
  runTelegramAction,
} from "./core";
import type {
  CopyableReaction,
  DeleteMessageOutcome,
  PendingMessageDeletion,
  TelegramMessageDeletionApi,
} from "../../../types/telegram";
import type { FlushResult } from "../../../types/lifecycle";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../../consts/telegram";
import { telegramErrorDetails } from "../errors";
import type { TelegramApi } from "../../../types/telegramWorker";

type MessageReactionApi = Pick<TelegramApi, "setMessageReaction">;
type EphemeralMessageDeletionApi = Pick<TelegramApi, "deleteEphemeralMessage">;

export interface DeleteEphemeralMessageParams {
  /** 目标群聊 ID。 */
  chatId: number;
  /** 专属消息的接收者用户 ID。 */
  receiverUserId: number;
  /** 目标专属消息 ID。 */
  ephemeralMessageId: number;
  /** 执行目标专属消息删除的 Telegram API 接口。 */
  api?: EphemeralMessageDeletionApi;
}

export interface SetMessageReactionParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 目标消息 ID。 */
  messageId: number;
  /** 要设置的标准 emoji 字符。 */
  emoji: string;
  /** 执行消息反应设置的 Telegram API 接口。 */
  api?: MessageReactionApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
}

export interface SetMessageReactionsParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 目标消息 ID。 */
  messageId: number;
  /** 要设置的反应列表（空数组表示清空反应）。 */
  reactions: CopyableReaction[];
  /** 执行消息反应设置的 Telegram API 接口。 */
  api?: MessageReactionApi;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
}

/**
 * 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。
 * @param params 单 emoji 反应设置参数。
 * @returns 设置成功返回 true，失败返回 false。
 */
export async function setMessageReaction({
  chatId,
  messageId,
  emoji,
  api = telegramApi,
  signal,
}: SetMessageReactionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    (requestSignal?: AbortSignal): Promise<true> =>
      api.setMessageReaction(
        chatId,
        messageId,
        [{
          type: "emoji",
          emoji: emoji as ReactionTypeEmoji["emoji"],
        }],
        {},
        telegramSignal(requestSignal)
      ),
    signal
  );
}

/**
 * 设置普通或自定义 emoji 反应；空数组清除反应，仅 API 落地成功时返回 true。
 * @param params 消息反应列表设置参数。
 * @returns 设置成功返回 true，失败返回 false。
 */
export async function setMessageReactions({
  chatId,
  messageId,
  reactions,
  api = telegramApi,
  signal,
}: SetMessageReactionsParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    (requestSignal?: AbortSignal): Promise<true> =>
      api.setMessageReaction(
        chatId,
        messageId,
        reactions,
        {},
        telegramSignal(requestSignal)
      ),
    signal
  );
}

/**
 * Telegram 是否明确说了「这条消息不存在或不可删」，而不是拒绝权限或偶发失败。
 * @param error 待判定的异常值。
 * @returns Telegram 明确返回消息不存在或不可删除时返回 true，否则返回 false。
 */
function isMessageGone(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details?.errorCode !== 400) {
    return false;
  }
  return /message to delete not found|ephemeral message (?:to delete )?not found|message can'?t be deleted/i.test(
    details.description
  );
}

/**
 * 执行一次删除并归入 deleted/gone/forbidden/failed 四态；普通删除与目标专属消息删除共用。
 * 「消息已经不在了」不记 API 错误；update 取消由统一边界
 * 直接上抛，其余取消由 runTelegramAction 统一不记。
 * @param action 日志中记录的删除动作名称。
 * @param execute 发起删除 API 请求的回调。
 * @returns 删除的四态结局。
 */
async function runDeletion(
  action: string,
  execute: (signal?: AbortSignal) => Promise<true>
): Promise<DeleteMessageOutcome> {
  let gone: boolean = false;
  let permissionDenied: boolean = false;
  const deleted: boolean = await runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      gone = isMessageGone(error);
      permissionDenied = !gone && isPermissionDenied(error);
      return !gone;
    },
  });
  if (deleted) return "deleted";
  if (gone) return "gone";
  return permissionDenied ? "forbidden" : "failed";
}

/**
 * 按群、接收者与临时消息 id 删除目标专属消息，并保留与普通删除相同的四态。
 * @param params 目标专属消息删除参数。
 * @returns 删除的四态结局。
 */
export function deleteEphemeralMessageWithOutcome(
  {
    chatId,
    receiverUserId,
    ephemeralMessageId,
    api = telegramApi,
  }: DeleteEphemeralMessageParams
): Promise<DeleteMessageOutcome> {
  return runDeletion(
    "delete ephemeral message",
    (signal?: AbortSignal): Promise<true> =>
      api.deleteEphemeralMessage({ chatId, receiverUserId, ephemeralMessageId }, signal)
  );
}

/**
 * 删一条消息并保留 deleted/gone/forbidden/failed 四态结局。
 * @param chatId 目标聊天 ID。
 * @param messageId 待删除的消息 ID。
 * @param api 执行单条消息删除的 Telegram API 接口。
 * @returns 删除的四态结局。
 */
export function deleteMessageWithOutcome(
  chatId: number,
  messageId: number,
  api: Pick<TelegramApi, "deleteMessage"> = telegramApi
): Promise<DeleteMessageOutcome> {
  return runDeletion(
    "delete message",
    (signal?: AbortSignal): Promise<true> => api.deleteMessage(chatId, messageId, telegramSignal(signal))
  );
}

/**
 * 删除一条消息，已删除或消息本来就不存在均视为已结清。
 * @param chatId 目标聊天 ID。
 * @param messageId 待删除的消息 ID。
 * @param api 执行单条消息删除的 Telegram API 接口。
 * @returns 已删除或已不存在时返回 true，权限拒绝或失败返回 false。
 */
export async function deleteMessage(
  chatId: number,
  messageId: number,
  api: Pick<TelegramApi, "deleteMessage"> = telegramApi
): Promise<boolean> {
  const outcome: DeleteMessageOutcome =
    await deleteMessageWithOutcome(chatId, messageId, api);
  // 「消息已经不在了」对只看成败的调用方就是成功。
  return isMessageDeletionSettled(outcome);
}

/**
 * 一次删掉同一个群里的多条消息。单次条数上限见 TELEGRAM_DELETE_MESSAGES_BATCH_MAX，且与
 * deleteMessage 一样只能删官方时限内的消息；超出由调用方分片，删不掉的个别消息 Telegram 自行跳过。
 * @param chatId 目标聊天 ID。
 * @param messageIds 待批量删除的消息 ID 列表。
 * @param api 执行批量消息删除的 Telegram API 接口。
 * @returns 空列表或 API 调用成功返回 true，失败返回 false。
 */
export async function deleteMessages(
  chatId: number,
  messageIds: readonly number[],
  api: Pick<TelegramApi, "deleteMessages"> = telegramApi
): Promise<boolean> {
  if (messageIds.length === 0) return true;
  return runBooleanTelegramAction(
    "delete messages",
    (signal?: AbortSignal): Promise<true> =>
      api.deleteMessages(
        chatId,
        [...messageIds],
        telegramSignal(signal)
      )
  );
}

export interface DeleteMessageAfterParams {
  /** 目标聊天 ID。 */
  chatId: number;
  /** 待延迟删除的消息 ID。 */
  messageId: number;
  /** 延迟删除等待时长（毫秒）。 */
  delayMs: number;
  /** 执行删除的 Telegram API 接口。 */
  api?: TelegramMessageDeletionApi;
}

/**
 * 认领一条待删消息并启动统一 Telegram 删除；timer 与停机 drain 只会成功一次。
 * @param entry 待认领并执行的延迟删除条目。
 */
function startMessageDeletion(entry: PendingMessageDeletion): void {
  if (!pendingMessageDeletions.delete(entry)) return;
  clearTimeout(entry.timer);
  trackMessageDeletion(deleteMessage(entry.chatId, entry.messageId, entry.api));
}

/**
 * 把一条已启动的删除接入统一在途集合；请求异常不会逃出清理边界。
 * @param request 已发起的删除请求 Promise。
 */
function trackMessageDeletion(request: Promise<boolean>): void {
  // 常规 API 错误已由 runTelegramAction 记录；这层只兜住边界自身的意外异常。
  trackBackgroundTask(
    inFlightMessageDeletions,
    request,
    "Unexpected error in delayed Telegram message deletion:"
  );
}

/**
 * 停机路径认领同客户端、同群的一批条目并发一次删除；批大小由调用方按 TELEGRAM_DELETE_MESSAGES_BATCH_MAX 切分。
 * @param entries 同客户端同群的一批待删条目。
 * @param api 执行批量删除的 Telegram API 接口。
 * @param chatId 目标聊天 ID。
 */
function startMessageDeletionBatch(
  entries: readonly PendingMessageDeletion[],
  api: TelegramMessageDeletionApi,
  chatId: number
): void {
  const messageIds: number[] = [];
  for (const entry of entries) {
    if (!pendingMessageDeletions.delete(entry)) continue;
    clearTimeout(entry.timer);
    messageIds.push(entry.messageId);
  }
  if (messageIds.length > 0) {
    trackMessageDeletion(deleteMessages(chatId, messageIds, api));
  }
}

/**
 * 延迟删除登记在册，timer 不阻止退出；正常停机由 drain 提前兑现。
 * @param params 延迟删除登记参数。
 */
export function deleteMessageAfter({
  chatId,
  messageId,
  delayMs,
  api = telegramApi,
}: DeleteMessageAfterParams): void {
  const entry: PendingMessageDeletion = {
    chatId,
    messageId,
    api,
    timer: setTimeout((): void => startMessageDeletion(entry), delayMs),
  };
  entry.timer.unref();
  pendingMessageDeletions.add(entry);
}

/**
 * 立即认领全部未到期条目，按客户端与群合批（每批不超过 TELEGRAM_DELETE_MESSAGES_BATCH_MAX）
 * 发 deleteMessages，并返回本线程当前所有在途删除句柄。正常到期仍逐条删除。Worker 可把这些
 * Promise 接入自己的 task tracker；主线程 drain 也复用它。
 * @returns 当前线程全部在途删除请求的 Promise 只读数组。
 */
export function flushPendingMessageDeletions(): readonly Promise<void>[] {
  const batches: Map<TelegramMessageDeletionApi, Map<number, PendingMessageDeletion[]>> = new Map();
  for (const entry of pendingMessageDeletions) {
    let byChat: Map<number, PendingMessageDeletion[]> | undefined =
      batches.get(entry.api);
    if (byChat === undefined) {
      byChat = new Map();
      batches.set(entry.api, byChat);
    }
    const entries: PendingMessageDeletion[] | undefined =
      byChat.get(entry.chatId);
    if (entries === undefined) byChat.set(entry.chatId, [entry]);
    else entries.push(entry);
  }
  for (const [api, byChat] of batches) {
    for (const [chatId, entries] of byChat) {
      for (
        let start: number = 0;
        start < entries.length;
        start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX
      ) {
        startMessageDeletionBatch(
          entries.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX),
          api,
          chatId
        );
      }
    }
  }
  return [...inFlightMessageDeletions];
}

/**
 * 正常停机前提前兑现本线程全部延迟删除，并等待已开始的删除请求。预算为零时不
 * 新建网络请求；超时只记诊断并返回。
 * @param timeoutMs 排空超时预算（毫秒）。
 * @returns 全部结算返回 "flushed"，预算耗尽返回 "timedOut"。
 */
export async function drainPendingMessageDeletions(timeoutMs: number): Promise<FlushResult> {
  if (timeoutMs <= 0 && (pendingMessageDeletions.size > 0 || inFlightMessageDeletions.size > 0)) {
    return "timedOut";
  }
  const deadline: number = createMonotonicDeadline(timeoutMs);
  while (pendingMessageDeletions.size > 0 || inFlightMessageDeletions.size > 0) {
    void flushPendingMessageDeletions();
    if (inFlightMessageDeletions.size === 0) continue;
    const remaining: number = remainingMonotonicTime(deadline);
    if (
      remaining === 0 ||
      !await settleWithinBudget([...inFlightMessageDeletions], remaining)
    ) {
      logger.error(
        `Delayed Telegram message deletion drain timed out with ` +
        `${pendingMessageDeletions.size} pending and ${inFlightMessageDeletions.size} in flight.`
      );
      return "timedOut";
    }
  }
  return "flushed";
}

/** 测试隔离/线程销毁时清理尚未触发的 timer；已发出的请求只能自然结算。 */
export function resetPendingMessageDeletions(): void {
  for (const entry of pendingMessageDeletions) clearTimeout(entry.timer);
  pendingMessageDeletions.clear();
}
