/** owner: main。群 teardown 注册表状态（packages/infra/chatTeardownRegistry.ts）。 */

import type {
  ChatRuntimeOwner,
  ChatTeardownCallback,
  ChatTeardownReason,
} from "../../types/chatTeardown";

/** 群 teardown 未注册业务处理器时的默认空操作回调。 */
const noChatTeardown: ChatTeardownCallback = (
  _chatId: number,
  _reason: ChatTeardownReason
): undefined => undefined;

/** 各业务模块注册的群 teardown 回调表：启动注册时填充固定槽位，运行期不清除、不淘汰；槽位数与 ChatRuntimeOwner 恒定同阶，进程重启后从空操作回调重新注册。 */
export const chatTeardownCallbacks: Record<ChatRuntimeOwner, ChatTeardownCallback> = {
  copy: noChatTeardown,
  translate: noChatTeardown,
  gag: noChatTeardown,
  deleteMessage: noChatTeardown,
  aiChat: noChatTeardown,
  antiRaid: noChatTeardown,
  qa: noChatTeardown,
  wed: noChatTeardown,
  joinLog: noChatTeardown,
};
