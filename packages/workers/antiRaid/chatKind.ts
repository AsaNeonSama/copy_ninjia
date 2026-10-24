/**
 * 群类型在入群守卫线程侧的读写口。
 *
 * 主线程按变更推送 `chatKind`，Worker 重建与进程启动时整表重放（见 packages/antiRaid/workerBridge/replay.ts）。
 * 镜像缺失时由本线程通过 `getChat` 同群去重反查；查询未确证时返回 `undefined`（只踢不封约束见 docs/cn/04-invariants.md）。
 */

import type { ChatFullInfo } from "grammy/types";
import { VERIFICATION_CHAT_KIND_FETCH_MAX } from "../../consts/antiRaid/verification";
import {
  workerChatIsSupergroup,
  workerChatKindFetches,
  workerChatKindActiveFetches,
} from "../../cache/workers/antiRaid/chatKind";
import { telegramApi } from "../../infra/telegram";
import { logger } from "../../infra/logger";

/**
 * 应用一条主线程镜像过来的群类型变化。
 * @param chatId 群组 ID。
 * @param isSupergroup 是否为超级群组（`supergroup`）。
 */
export function applyChatKindChange(chatId: number, isSupergroup: boolean): void {
  workerChatKindFetches.delete(chatId);
  workerChatIsSupergroup.set(chatId, isSupergroup);
}

/**
 * 读取群类型；镜像缺失时由执行线程直接 getChat，并让同群终态复用在途请求。
 * @param chatId 群组 ID。
 * @returns 只返回确证值；查询失败、非群聊或并发已满均返回 undefined。
 */
export function resolveChatIsSupergroup(
  chatId: number
): Promise<boolean | undefined> {
  const known: boolean | undefined = workerChatIsSupergroup.get(chatId);
  if (known !== undefined) return Promise.resolve(known);
  const existing: Promise<boolean | undefined> | undefined =
    workerChatKindFetches.get(chatId);
  if (existing !== undefined) return existing;
  if (workerChatKindActiveFetches.size >= VERIFICATION_CHAT_KIND_FETCH_MAX) {
    return Promise.resolve(undefined);
  }
  const task: Promise<boolean | undefined> = telegramApi.getChat(chatId)
    .then((chat: ChatFullInfo): boolean | undefined => {
      // 主线程镜像可能在查询期间到达：迟到请求不覆盖它，当前等待者直接使用那份更新值。
      if (workerChatKindFetches.get(chatId) !== task) {
        return workerChatIsSupergroup.get(chatId);
      }
      if (chat.type !== "group" && chat.type !== "supergroup") {
        logger.error(`Chat kind lookup for chat ${chatId} returned a non-group chat.`);
        return undefined;
      }
      const isSupergroup: boolean = chat.type === "supergroup";
      workerChatIsSupergroup.set(chatId, isSupergroup);
      return isSupergroup;
    })
    .catch((error: unknown): undefined => {
      logger.error(`Failed to resolve chat kind for chat ${chatId}:`, error);
      return undefined;
    })
    .finally((): void => {
      workerChatKindActiveFetches.delete(task);
      if (workerChatKindFetches.get(chatId) === task) {
        workerChatKindFetches.delete(chatId);
      }
    });
  workerChatKindActiveFetches.add(task);
  workerChatKindFetches.set(chatId, task);
  return task;
}

/**
 * 停管/`/init disable`/群 teardown：丢掉这个群的群类型镜像。
 * @param chatId 群组 ID。
 */
export function forgetWorkerChatKind(chatId: number): void {
  workerChatKindFetches.delete(chatId);
  workerChatIsSupergroup.delete(chatId);
}

/** Worker stop/测试隔离时清空整表；重建后由主线程重放。 */
export function resetWorkerChatKind(): void {
  workerChatKindFetches.clear();
  workerChatKindActiveFetches.clear();
  workerChatIsSupergroup.clear();
}
