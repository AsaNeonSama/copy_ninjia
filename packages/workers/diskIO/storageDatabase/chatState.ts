import {
  storagePendingBudgets,
  pendingChatStateWrites,
  storageFlushHold,
} from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../consts/storage";
import {
  assertTelegramChatId,
  decodeChatStateData,
} from "../../../database/codec/chatState";
import {
  readStoredChatStateIds,
  readStoredChatStates,
} from "../../../database/interact/chatState";
import type {
  ChatStateWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type {
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import type { ChatState } from "../../../types/chatState";
import type { PendingChatStateWrite } from "../../../types/identityStorage";
import type { StoredChatStateRow } from "../../../types/storageDatabase";
import {
  assertPositiveRevision,
  requireStorageDatabase,
  requireStorageDatabaseReader,
  storageSource,
} from "./context";
import { flushIfStorageFull } from "./flush";

/** 读取已提交群主键并叠加待提交变更，返回有效群 ID 集合。 */
function effectiveChatStateIds(): Set<number> {
  const rows: readonly Pick<StoredChatStateRow, "chatId">[] =
    readStoredChatStateIds(requireStorageDatabaseReader());
  const chatIds: Set<number> = new Set();
  for (const row of rows) chatIds.add(row.chatId);
  for (const [chatId, pending] of pendingChatStateWrites) {
    if (pending.data === null) chatIds.delete(chatId);
    else chatIds.add(chatId);
  }
  return chatIds;
}

/** 读取已提交群状态并叠加待提交变更，返回有效群状态映射。 */
function effectiveChatStateData(): Map<number, ChatState> {
  const rows: readonly StoredChatStateRow[] = readStoredChatStates(requireStorageDatabase());
  const values: Map<number, ChatState> = new Map();
  for (const row of rows) values.set(row.chatId, decodeChatStateData(row.data, storageSource("chat_states", row.chatId), row.chatId));
  for (const [chatId, pending] of pendingChatStateWrites) {
    if (pending.data === null) values.delete(chatId);
    else values.set(chatId, decodeChatStateData(pending.data, storageSource("chat_states", chatId), chatId));
  }
  return values;
}

/** 校验有效群总数不超过 STATE_MANAGED_CHAT_LIMIT。 */
function assertManagedChatLimit(effective: ReadonlySet<number>): void {
  if (effective.size > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:chat_states must contain at most ` +
      `${STATE_MANAGED_CHAT_LIMIT} chats; delete chats that are no longer managed before adding another chat.`
    );
  }
}

/** 镜像重放结束时统一复核待提交群状态的群数上限与唯一代理目标约束。 */
export function assertPendingChatStateInvariants(): void {
  if (pendingChatStateWrites.size === 0) return;
  assertManagedChatLimit(effectiveChatStateIds());
  let hasProxySend: boolean = false;
  for (const data of effectiveChatStateData().values()) {
    if (data.isProxySendEnabled !== true) continue;
    if (hasProxySend) {
      throw new Error(
        `${IDENTITY_DATABASE_PATH}:chat_states must contain at most one active proxy send target.`
      );
    }
    hasProxySend = true;
  }
}

/** 校验并接收群状态写入，验证群数上限与唯一代理目标约束（镜像重放暂挂期间延后至重放结束统一复核）后排入事务缓冲。 */
export function handleChatStateWrite(
  message: ChatStateWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const rowSource: string = storageSource("chat_states", message.chatId);
  assertTelegramChatId(message.chatId, rowSource);
  assertPositiveRevision(message.revision, rowSource);
  const incoming: ChatState | null = message.data === null
    ? null
    : decodeChatStateData(message.data, rowSource, message.chatId);
  const current: PendingChatStateWrite | undefined = pendingChatStateWrites.get(
    message.chatId
  );
  if (current !== undefined && current.revision >= message.revision) return;

  if (!storageFlushHold.current) {
    const effective: Set<number> = effectiveChatStateIds();
    if (message.data === null) effective.delete(message.chatId);
    else effective.add(message.chatId);
    assertManagedChatLimit(effective);
    if (incoming?.isProxySendEnabled === true) {
      for (const [chatId, data] of effectiveChatStateData()) {
        if (chatId === message.chatId) continue;
        if (
          data.isProxySendEnabled === true
        ) {
          throw new Error(
            `${IDENTITY_DATABASE_PATH}:chat_states must contain at most one active proxy send target.`
          );
        }
      }
    }
  }
  storagePendingBudgets.chatState.reserve(current === undefined ? 1 : 0, storageWriteCost(message.data) - (current === undefined ? 0 : storageWriteCost(current.data)));
  pendingChatStateWrites.set(message.chatId, {
    data: message.data,
    revision: message.revision,
  });
  flushIfStorageFull(reply);
}
