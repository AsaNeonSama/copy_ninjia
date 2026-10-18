/**
 * AI 闲聊可用性判定入口。
 * @see ../../docs/cn/04-invariants.md
 */

import { aiChatConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";

/** 进程侧是否已具备运行 AI 闲聊所需的全部有效部署配置。 */
export function isAiChatConfigured(): boolean {
  return aiChatConfigReadiness().ok;
}

/** 指定群聊当前是否启用 AI 闲聊（进程侧配置就绪且群开关开启）。 */
export function isAiChatActiveIn(chatId: number): boolean {
  return isAiChatConfigured() && getChatState(chatId).isAIChatEnabled === true;
}
