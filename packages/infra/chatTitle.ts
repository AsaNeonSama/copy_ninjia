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
import {
  CHAT_ABSENCE_CONFIRM_ATTEMPTS,
  CHAT_ABSENCE_CONFIRM_INTERVAL_MS,
  CHAT_TITLE_REFRESH_CONCURRENCY,
} from "../consts/chatTeardown";
import { runBoundedSettledBatch } from "../libs/boundedSettledBatch";
import type { BoundedBatchExecution } from "../libs/boundedSettledBatch";
import type { ChatState } from "../types/chatState";
import type { ChatDepartureReason } from "../types/chatTeardown";

/**
 * 各群名称追踪与持久化（`ChatState.title`，随 SQLite `chat_states` 落盘）：
 * 启动时通过 `refreshAllChatTitles` 全量刷新并收尾确证不可达的群，运行期随群消息通过 `recordChatTitleFromChat` 原地更新。
 */

/**
 * 将确证的群名称写入已启用 `/init` 的内存 `ChatState`；未启用或名称未变时返回 false。
 * @param chatId 目标群 ID。
 * @param title 确证的最新群名称。
 * @param currentState 已读取的当前群状态只读视图。
 * @returns 群名称发生变更并写入内存时返回 true，否则返回 false。
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

/**
 * 名称有变化才后台落盘。
 * @param chatId 目标群 ID。
 * @param title 确证的最新群名称。
 * @param currentState 已读取的当前群状态只读视图。
 */
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
 * 从群消息更新中记录 `chat.title`（仅处理群组与超级群组）。
 * @param chat 消息所属的 Telegram 会话对象。
 * @param currentState 同一同步消息入口已读取的当前群状态。
 */
export function recordChatTitleFromChat(
  chat: Chat,
  currentState: Readonly<ChatState>
): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  recordChatTitle(chat.id, chat.title, currentState);
}

/** 一次 `getChat` 的结论：查到群资料、确证群不可达，或单次请求失败。 */
type ChatLookup =
  | { readonly kind: "found"; readonly chat: ChatFullInfo }
  | { readonly kind: "absent"; readonly reason: ChatDepartureReason }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * 调用 Telegram `getChat` 并归类为查到群资料、群不可达或请求失败。
 * @param chatId 目标群 ID。
 * @param signal 控制本次请求取消的 AbortSignal。
 * @returns 归类后的 `ChatLookup` 结果。
 */
async function lookUpChat(chatId: number, signal: AbortSignal): Promise<ChatLookup> {
  try {
    return { kind: "found", chat: await bot.api.getChat(chatId, telegramSignal(signal)) };
  } catch (error: unknown) {
    const reason: ChatDepartureReason | null = classifyChatAbsence(error);
    return reason === null ? { kind: "failed", error } : { kind: "absent", reason };
  }
}

/**
 * 首次 `getChat` 判定群不可达后，按 `CHAT_ABSENCE_CONFIRM_INTERVAL_MS` 间隔重查至
 * `CHAT_ABSENCE_CONFIRM_ATTEMPTS` 次；每次均得到同一结论才调用 `completeChatDeparture` 收尾。
 * @param chatId 目标群 ID。
 * @param reason 首次探测判定的群不可达原因。
 * @param signal 控制刷新流程取消的 AbortSignal。
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
 * 启动后台刷新：按 `CHAT_TITLE_REFRESH_CONCURRENCY` 并发上限查询已知受管群的当前名称并回填；
 * 确证群不可达时转入 `confirmChatAbsence` 收尾。
 * @param signal 控制全量刷新取消的 AbortSignal；缺省使用运行时自身的 controller.signal。
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
    maxConcurrent: CHAT_TITLE_REFRESH_CONCURRENCY,
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

/** 重置群名称刷新的取消控制器并打开接纳开关。 */
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

/** 停止接纳并立即中断所有在途的群名称刷新与不可达确证请求。 */
export function abortChatTitleRefresh(): void {
  chatTitleRefreshRuntime.accepting = false;
  chatTitleRefreshRuntime.absenceConfirmation.abort();
  if (!chatTitleRefreshRuntime.controller.signal.aborted) chatTitleRefreshRuntime.controller.abort();
}
