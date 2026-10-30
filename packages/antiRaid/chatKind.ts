/**
 * 群类型的主线程观测口：把 `chat.type` 写入 `chatIsSupergroupById` 并镜像给入群守卫线程，
 * 供踢人分派「只踢不封」时选择对应的 Bot API 方法（见 workers/antiRaid/chatKind.ts 与
 * infra/telegram/actions/moderation.ts），以及供 Mini App `/batch_kick` 校验超级群身份。
 *
 * 权威线程为主线程，取值变化时增量推送；Worker 重建后由 workerBridge/replay.ts
 * 整表重放，teardown 清理见 workerBridge/observers.ts。本模块只负责观测与去重。
 */

import { chatIsSupergroupById } from "../cache/main/antiRaid/chatKind";
import { getChatState } from "../infra/storage/stateStore";
import { postAntiRaid } from "./workerBridge/controller";
import type { Chat } from "grammy/types";

/**
 * 记录并在取值变化时向 Worker 镜像群类型（仅接受已启用 `/init` 的 `group` 或 `supergroup`）。
 *
 * @param chat 包含 `id` 与 `type` 的 Telegram 会话对象
 */
export function observeChatKind(chat: Pick<Chat, "id" | "type">): void {
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const isSupergroup: boolean = chat.type === "supergroup";
  if (chatIsSupergroupById.get(chat.id) === isSupergroup) return;
  if (getChatState(chat.id).isInitEnabled !== true) return;
  chatIsSupergroupById.set(chat.id, isSupergroup);
  postAntiRaid({ type: "chatKind", chatId: chat.id, isSupergroup });
}
