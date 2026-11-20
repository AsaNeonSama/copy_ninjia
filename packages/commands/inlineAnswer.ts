/**
 * 个人内联查询应答的共享边界（供 gag 与运势 inline 适配层共用）。
 *
 * 直接调用 `ctx.answerInlineQuery` 并区分 Bot API 明确拒收与网络等不确定失败，
 * 不经 `runTelegramAction`（保持明确拒收判定与成功后的既有收尾语义）。
 */

import type { Context } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { logApiError } from "../infra/telegram";
import { isTelegramRequestRejected } from "../infra/telegram/errors";
import { currentUpdateAbortSignal, throwIfUpdateAborted } from "../infra/updateContext";
import { telegramSignal } from "../libs/telegramSignal";

/** `answerInlineQuery` 的入参。 */
export interface AnswerInlineQueryParams {
  /** grammY 上下文。 */
  readonly ctx: Context;
  /** 待应答的内联结果条目列表。 */
  readonly results: readonly InlineQueryResultArticle[];
  /** Telegram 客户端缓存该应答的秒数（`cache_time`）。 */
  readonly cacheTime: number;
  /** 应答失败时写入 Telegram 错误日志的动作名。 */
  readonly action: string;
}

/**
 * 应答一次个人内联查询（固定 `is_personal: true` 并附带当前 update 取消信号）。
 *
 * 捕获异常时若当前 update 已中止则重新抛出；否则经 `logApiError` 记录错误，
 * 并返回是否被 Telegram Bot API 明确拒收（请求成功或失败原因不确定时返回 `false`）。
 *
 * @param params 内联查询上下文、结果列表、缓存秒数与错误日志动作名。
 * @returns 被 Telegram Bot API 明确拒收时返回 `true`；成功或失败原因不确定时返回 `false`。
 */
export async function answerInlineQuery({
  ctx,
  results,
  cacheTime,
  action,
}: AnswerInlineQueryParams): Promise<boolean> {
  try {
    await ctx.answerInlineQuery(
      results,
      { cache_time: cacheTime, is_personal: true },
      telegramSignal(currentUpdateAbortSignal())
    );
    return false;
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError(action, error);
    return isTelegramRequestRejected(error);
  }
}
