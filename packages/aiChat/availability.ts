/**
 * AI 闲聊可用性判定入口。
 * @see ../../docs/cn/04-invariants.md
 */

import { aiChatConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";

/**
 * 进程侧是否已具备运行 AI 闲聊所需的全部有效部署配置。
 * @returns 部署配置就绪时返回 `true`，否则返回 `false`。
 */
export function isAiChatConfigured(): boolean {
  return aiChatConfigReadiness().ok;
}

/**
 * 指定群聊当前是否启用 AI 闲聊（进程侧配置就绪且群开关开启）。
 * @param chatId 群聊 ID。
 * @returns 进程配置就绪且该群开启 AI 闲聊时返回 `true`，否则返回 `false`。
 */
export function isAiChatActiveIn(chatId: number): boolean {
  return isAiChatConfigured() && getChatState(chatId).isAIChatEnabled === true;
}
