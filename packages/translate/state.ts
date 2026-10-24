import { TRANSLATE_CHAT_USER_LIMIT } from "../consts/translate";
import { registerChatTeardown } from "../infra/chatTeardownRegistry";
import {
  getChatStateCache,
  persistChatState,
} from "../infra/storage/stateStore";
import { isTelegramGroupChatId } from "../libs/telegramId";
import type { ChatState } from "../types/chatState";
import type { TranslateState } from "../types/translate";

/**
 * 翻译会话保存在群状态的 translate 字段，随 `chat_states` 持久化（见
 * types/chatState.ts）。从调用方给出的群状态里查指定目标的现有会话，不创建投影对象。
 * @param chatState 当前群聊的状态快照。
 * @param userId 待查询的被翻译目标用户 ID。
 * @returns 命中时返回对应的翻译会话状态，未配置时返回 undefined。
 */
export function translateStateIn(chatState: Readonly<ChatState>, userId: number): TranslateState | undefined {
  const states: readonly TranslateState[] | undefined = chatState.translate;
  if (states === undefined) return undefined;
  for (const state of states) {
    if (state.translatedUser.id === userId) return state;
  }
  return undefined;
}

/**
 * 创建或替换本群一个目标的会话；只读已初始化的群状态（缺失时抛错，不隐式新建群状态），
 * 同步检查每群人数上限（达到上限返回 false），不淘汰其他目标。
 * 调用方随后经 persistChatState 落盘；目标身份按 Telegram 给出的原样保存，空字符串名称同样保留。
 * @param chatId 群聊 ID（负数安全整数）。
 * @param state 待写入的翻译会话状态。
 * @returns 写入成功时返回 true；新增目标且已达单群上限时返回 false。
 */
export function setTranslateState(chatId: number, state: TranslateState): boolean {
  if (!isTelegramGroupChatId(chatId)) throw new Error("Translation chat ID must be a negative safe integer.");
  const chatState: ChatState | undefined = getChatStateCache().get(chatId);
  if (chatState === undefined) {
    throw new Error(`Cannot set translation state for uninitialized chat ${chatId}.`);
  }
  const current: readonly TranslateState[] | undefined = chatState.translate;
  if (current === undefined) {
    chatState.translate = [state];
    return true;
  }
  const index: number = current.findIndex((entry: TranslateState): boolean => entry.translatedUser.id === state.translatedUser.id);
  if (index < 0 && current.length >= TRANSLATE_CHAT_USER_LIMIT) return false;
  const updated: TranslateState[] = [...current];
  if (index < 0) updated.push(state);
  else updated[index] = state;
  chatState.translate = updated;
  return true;
}

/**
 * 停止本群全部或指定目标的翻译并等待群状态落盘；重复停止也确认持久化。
 * @param chatId 群聊 ID。
 * @param userId 可选的指定目标用户 ID；缺省时清空本群全部翻译目标。
 */
export async function stopTranslation(chatId: number, userId?: number): Promise<void> {
  const chatState: ChatState | undefined = getChatStateCache().get(chatId);
  const current: readonly TranslateState[] | undefined = chatState?.translate;
  if (chatState !== undefined && current !== undefined) {
    const remaining: readonly TranslateState[] = userId === undefined
      ? []
      : current.filter((entry: TranslateState): boolean => entry.translatedUser.id !== userId);
    chatState.translate = remaining.length === 0 ? undefined : remaining;
  }
  await persistChatState(chatId, "translation stopped");
}

registerChatTeardown("translate", (chatId: number): Promise<void> => stopTranslation(chatId));
