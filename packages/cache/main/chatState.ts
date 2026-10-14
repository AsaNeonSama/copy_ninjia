/** owner: main。主线程群状态热读缓存与未 ACK 写入跟踪（packages/infra/chatStateStorage.ts）。 */

import type { ChatState } from "../../types/chatState";
import type { UnacknowledgedChatStateWrite } from "../../types/identityStorage";

/**
 * SQLite `chat_states` 的主线程权威热读缓存。
 *
 * 填充：启动时由 hydrateChatStateCache 全量灌入，运行期新建群状态前经 assertChatStateCapacity
 * 校验容量。清理：群状态字段全部清空、机器人离群且无 lockdown 记录，或 resetChatStateCache
 * 时删除。容量上限为 STATE_MANAGED_CHAT_LIMIT，满额抛错拒绝新建，不设淘汰；进程重启后从
 * SQLite 重建。
 */
export const chatStateCache: Map<number, ChatState> = new Map();

/**
 * 已发出但尚未收到 Disk I/O 精确 ACK 的群状态写入（chatId -> revision 与删除标记）。
 * 填充：queueChatStateWrite 发出写入时登记。清理：收到匹配 revision 的
 * identityStoragePersisted ACK 时删除；Disk I/O Worker 重建时不清空，全表重放后待 ACK 移除。
 * 容量上限为 STATE_MANAGED_CHAT_LIMIT，不设淘汰。
 */
export const unacknowledgedChatStateWrites: Map<
  number,
  UnacknowledgedChatStateWrite
> = new Map();

/**
 * unacknowledgedChatStateWrites 全部条目的估算字节总数；登记或覆盖时按差额更新，
 * 精确 ACK 时扣减，重放时按重编码结果更新，resetChatStateCache 时归零。
 */
export const unacknowledgedChatStateBytes: { current: number } = { current: 0 };

/** 群状态写入 revision 单调发号器；主线程同步自增，resetChatStateCache 时归零。 */
export const chatStateWriteRevision: { current: number } = { current: 0 };

/** 新生命周期启动或测试隔离时重置群状态热读缓存与未 ACK 记账。 */
export function resetChatStateCache(): void {
  chatStateCache.clear();
  unacknowledgedChatStateWrites.clear();
  unacknowledgedChatStateBytes.current = 0;
  chatStateWriteRevision.current = 0;
}
