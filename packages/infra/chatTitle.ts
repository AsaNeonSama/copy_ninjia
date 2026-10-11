import type { Chat, ChatFullInfo } from "grammy/types";
import { sleepUnlessAborted } from "../libs/sleep";
import { telegramSignal } from "../libs/telegramSignal";
import { completeChatDeparture } from "./botAdmin";
import { logger } from "./logger";
import { bot } from "./telegram/mainClient";
import { classifyChatAbsence } from "./telegram/errors";
import {
  getChatStateCache,
  getChatState,
  getOrCreateChatState,
  saveChatStateInBackground,
} from "./storage/stateStore";
import { chatTitleRefreshRuntime } from "../cache/main/chatTitle";
import { CHAT_ABSENCE_CONFIRM_ATTEMPTS, CHAT_ABSENCE_CONFIRM_INTERVAL_MS } from "../consts/chatTeardown";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { runBoundedSettledBatch } from "../libs/boundedSettledBatch";
import type { BoundedBatchExecution } from "../libs/boundedSettledBatch";
import type { ChatState } from "../types/chatState";
import type { ChatDepartureReason } from "../types/chatTeardown";

/**
 * 各群名称的追踪与持久化（ChatState.title，随 SQLite 群状态行落盘）。群名称不
 * 参与业务判断，只用于核对数据库条目对应的群。
 *
 * 维护路径两条，互为补充：
 * 1. 启动时对已知的每个群现查一次（refreshAllChatTitles，见 app/lifecycle.ts）——
 *    覆盖存量群与上次运行期间改名的群；查询确证群已不可达时顺带收尾该群（见 confirmChatAbsence）；
 * 2. 此后每条收到的群消息，其 chat.title 随更新一起送达，不调 API，
 *    直接记录/刷新（recordChatTitleFromChat，见
 *    packages/auto/message/ 的 handleIncomingMessageMiddleware）。
 */

/**
 * 把确证的群名称写入内存 ChatState；未初始化的群（isInitEnabled !== true）或与已知值
 * 相同时不写并返回 false，同 infra/botAdmin.ts 的 recordBotChatPermissions，
 * 未初始化的群不建 `chat_states` 条目。
 * @returns 是否改写了名称，调用方据此决定是否落盘。
 */
function applyChatTitle(
  chatId: number,
  title: string,
  currentState: Readonly<ChatState>
): boolean {
  if (currentState.isInitEnabled !== true || currentState.title === title) return false;
  const chatState: ChatState = getOrCreateChatState(chatId);
  chatState.title = title;
  return true;
}

/** 名称有变化才后台落盘。 */
function recordChatTitle(
  chatId: number,
  title: string,
  currentState: Readonly<ChatState>
): void {
  if (applyChatTitle(chatId, title, currentState)) {
    saveChatStateInBackground(chatId, "chat title refresh");
  }
}

/**
 * 群消息/频道帖更新里顺手记录 chat.title，零额外 API 开销。私聊没有群名称，
 * 频道机器人不做任何管理，都不记录（同 infra/botAdmin.ts 的范围限定）。
 * @param currentState 同一同步消息入口已读取的当前群状态；缺省时本函数自行读取。
 */
export function recordChatTitleFromChat(
  chat: Chat,
  currentState?: Readonly<ChatState>
): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  recordChatTitle(chat.id, chat.title, currentState ?? getChatState(chat.id));
}

/** 一次 getChat 的结论：查到群资料，确证群不可达（见 classifyChatAbsence），或只是这次没查到。 */
type ChatLookup =
  | { readonly kind: "found"; readonly chat: ChatFullInfo }
  | { readonly kind: "absent"; readonly reason: ChatDepartureReason }
  | { readonly kind: "failed"; readonly error: unknown };

async function lookUpChat(chatId: number, signal: AbortSignal): Promise<ChatLookup> {
  try {
    return { kind: "found", chat: await bot.api.getChat(chatId, telegramSignal(signal)) };
  } catch (error: unknown) {
    const reason: ChatDepartureReason | null = classifyChatAbsence(error);
    return reason === null ? { kind: "failed", error } : { kind: "absent", reason };
  }
}

/**
 * 首次 getChat 已判定群不可达后，按 CHAT_ABSENCE_CONFIRM_INTERVAL_MS 间隔重查，直到累计
 * CHAT_ABSENCE_CONFIRM_ATTEMPTS 次。每次都得到同一类结论才经 completeChatDeparture 收尾并记一条 warn；
 * 中途查到群、得到别的结论或错误、该群已不在群状态表里，或等待被 quiesce/abort 打断，都放弃，本次不收尾。
 */
async function confirmChatAbsence(
  chatId: number,
  reason: ChatDepartureReason,
  signal: AbortSignal
): Promise<void> {
  for (let attempt: number = 1; attempt < CHAT_ABSENCE_CONFIRM_ATTEMPTS; attempt++) {
    if (!await sleepUnlessAborted(CHAT_ABSENCE_CONFIRM_INTERVAL_MS, chatTitleRefreshRuntime.absenceConfirmation.signal)) return;
    if (signal.aborted || !getChatStateCache().has(chatId)) return;
    const lookup: ChatLookup = await lookUpChat(chatId, signal);
    if (signal.aborted) return;
    if (lookup.kind !== "absent" || lookup.reason !== reason) {
      logger.info(`Chat ${chatId} looked ${reason} at startup but lookup ${attempt + 1} disagreed; keeping it.`);
      return;
    }
  }
  if (!getChatStateCache().has(chatId)) return;
  logger.warn(
    `Chat ${chatId} was ${reason} in ${CHAT_ABSENCE_CONFIRM_ATTEMPTS} lookups ` +
    `${CHAT_ABSENCE_CONFIRM_INTERVAL_MS}ms apart; tearing it down.`
  );
  await completeChatDeparture(chatId, reason);
}

/**
 * 启动流程：给 SQLite 里已知的每个群现查一次当前群名称并回填。不阻塞
 * bot 启动主流程，个别群查询失败不影响其它群。app/lifecycle.ts 追踪该任务，并在
 * 最终持久化 flush 前等待它完成。共享的 bot.api 客户端把 429 请求退回主线程
 * query 类别队列。并发上限取 STATE_MANAGED_CHAT_LIMIT，即每个受管群各查一次。
 * 查询确证群已不可达时转入 confirmChatAbsence。
 */
export async function refreshAllChatTitles(
  signal: AbortSignal = chatTitleRefreshRuntime.controller.signal
): Promise<void> {
  if (!chatTitleRefreshRuntime.accepting || signal.aborted) return;
  const chatIds: number[] = [...getChatStateCache().keys()];
  const total: number = chatIds.length;
  const startedAt: number = Date.now();
  let completed: number = 0;
  logger.info(`Chat title refresh started: total=${total}.`);
  await runBoundedSettledBatch<number, void>({
    items: chatIds,
    maxConcurrent: STATE_MANAGED_CHAT_LIMIT,
    execute: async ({ item: chatId }: BoundedBatchExecution<number>): Promise<void> => {
      if (signal.aborted) return;
      try {
        const lookup: ChatLookup = await lookUpChat(chatId, signal);
        if (signal.aborted) return;
        if (lookup.kind === "found") {
          if (lookup.chat.type === "group" || lookup.chat.type === "supergroup") {
            recordChatTitle(chatId, lookup.chat.title, getChatState(chatId));
          }
        } else if (lookup.kind === "absent") {
          await confirmChatAbsence(chatId, lookup.reason, signal);
        } else {
          // 单个群查询失败不中断其它群的回填。
          logger.error(`Failed to refresh chat title for chat ${chatId}:`, lookup.error);
        }
      } catch (error: unknown) {
        // 收尾失败只记日志，不中断其它群；下次启动重新确证。
        logger.error(`Failed to tear down unreachable chat ${chatId}:`, error);
      } finally {
        completed++;
      }
    },
  });
  logger.info(
    `Chat title refresh ${signal.aborted ? "aborted" : "completed"}: ` +
    `${completed}/${total}, elapsed=${Date.now() - startedAt}ms.`
  );
}

export function initChatTitleRefresh(): void {
  chatTitleRefreshRuntime.controller = new AbortController();
  chatTitleRefreshRuntime.absenceConfirmation = new AbortController();
  chatTitleRefreshRuntime.accepting = true;
}

/** 停止接纳新的刷新，并打断不可达确证的等待；在途的 getChat 照常结算。 */
export function quiesceChatTitleRefresh(): void {
  chatTitleRefreshRuntime.accepting = false;
  chatTitleRefreshRuntime.absenceConfirmation.abort();
}

export function abortChatTitleRefresh(): void {
  chatTitleRefreshRuntime.accepting = false;
  chatTitleRefreshRuntime.absenceConfirmation.abort();
  if (!chatTitleRefreshRuntime.controller.signal.aborted) chatTitleRefreshRuntime.controller.abort();
}
