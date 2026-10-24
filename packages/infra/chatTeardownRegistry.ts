import { chatTeardownCallbacks } from "../cache/main/chatTeardown";
import type {
  ChatRuntimeOwner,
  ChatTeardownCallback,
  ChatTeardownReason,
} from "../types/chatTeardown";
import { toErrorOr } from "../libs/errorMessage";

/**
 * 上层 owner 反向注册 teardown；本叶子注册表不静态依赖任何业务领域。
 * @param owner 群运行时 owner 标识。
 * @param callback 该 owner 对应的群 teardown 回调。
 */
export function registerChatTeardown(owner: ChatRuntimeOwner, callback: ChatTeardownCallback): void {
  chatTeardownCallbacks[owner] = callback;
}

/**
 * 执行指定 owner 当前注册的 teardown；未注册时是显式 no-op。
 * @param owner 群运行时 owner 标识。
 * @param chatId 目标群 ID。
 * @param reason 触发群运行时 teardown 的原因。
 * @returns 表达该 owner teardown 完成或失败的 Promise。
 */
export function teardownRegisteredChat(
  owner: ChatRuntimeOwner,
  chatId: number,
  reason: ChatTeardownReason
): Promise<void> {
  try {
    return Promise.resolve(chatTeardownCallbacks[owner](chatId, reason));
  } catch (error: unknown) {
    // owner 必须在调用栈内同步关闸；这里只把同步异常标准化为 rejected Promise，
    // 让组合 teardown 仍能启动其余 owner 并统一等待全部结果。
    return Promise.reject(toErrorOr(error, "Chat teardown callback threw a non-Error value."));
  }
}
