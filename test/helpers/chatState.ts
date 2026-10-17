import { createChatState } from "../../packages/libs/chatState";
import type { ChatState } from "../../packages/types/chatState";

/** 以规范形状（createChatState）为底覆盖指定字段，构造测试用群状态。 */
export function chatStateOf(overrides: Partial<ChatState> = {}): ChatState {
  return { ...createChatState(), ...overrides };
}

/** 返回按群读写并在缺失时由工厂初始化条目的获取函数。 */
export function chatStateLookup<T>(
  chatStates: Map<number, T>,
  createState: () => T
): (chatId: number) => T {
  return (chatId: number): T => {
    let chatState: T | undefined = chatStates.get(chatId);
    if (chatState === undefined) {
      chatState = createState();
      chatStates.set(chatId, chatState);
    }
    return chatState;
  };
}
