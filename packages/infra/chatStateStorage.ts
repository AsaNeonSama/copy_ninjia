/**
 * 主线程群状态读写门面与持久化边界：至多 STATE_MANAGED_CHAT_LIMIT 项的 chatStateCache 是唯一热读副本，
 * SQLite 是权威落盘源。
 *
 * 写入先发布热读副本最终值，再只保留 revision 与删除墓碑，正文不复制到第二张主线程
 * Map；Disk I/O Worker 崩溃后从热读副本重编码并重放未 ACK revision。
 */

import { assertStorageAdmission } from "./diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "./diskIO/transport";
import { describeFlushFailure, postWithTransport } from "./diskIO/businessWrite";
import { storageWriteCost } from "../libs/storageWriteBudget";
import {
  chatStateCache,
  chatStateWriteRevision,
  resetChatStateCache,
  unacknowledgedChatStateBytes,
  unacknowledgedChatStateWrites,
} from "../cache/main/chatState";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { IDENTITY_DATABASE_PATH } from "../consts/paths";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import {
  assertTelegramChatId,
  encodeChatStateData,
} from "../database/codec/chatState";
import {
  DEFAULT_CHAT_STATE,
  adoptChatState,
  createChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../libs/chatState";
import * as diskIO from "./diskIO";
import { logger } from "./logger";
import { throwIfUpdateAborted } from "./updateContext";
import type {
  ChatState,
  ChatStateOptionalField,
  ChatStateSwitchKey,
} from "../types/chatState";
import type {
  ChatStateWriteDiskMessage,
  DiskIORecoveryTransport,
} from "../types/diskIO/messages";
import type {
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../types/diskIO/replies";
import type { UnacknowledgedChatStateWrite } from "../types/identityStorage";

/** 群状态当前热表现编码后的序列化文本或删除墓碑。 */
interface EncodedChatStateWrite {
  readonly data: string | null;
  readonly deleted: boolean;
}

/** 待按 revision 升序重放的未确认群状态写入条目。 */
interface QueuedChatStateWrite {
  readonly chatId: number;
  readonly revision: number;
}

/**
 * 构造受管群数量超过 `STATE_MANAGED_CHAT_LIMIT` 时的容量超限错误。
 * @returns 描述受管群容量上限的 Error 实例。
 */
function capacityError(): Error {
  return new Error(
    `${IDENTITY_DATABASE_PATH}:chat_states must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
    "delete chats that are no longer managed before adding another chat."
  );
}

/**
 * 启动恢复把 SQLite 持久化值载入固定 shape 的热读副本。
 * @param states 从 SQLite 读取并解码的群状态映射。
 */
export function hydrateChatStateCache(states: ReadonlyMap<number, ChatState>): void {
  resetChatStateCache();
  for (const [chatId, decoded] of states) {
    const state: ChatState = adoptChatState(decoded);
    normalizeChatState(state);
    chatStateCache.set(chatId, state);
  }
}

/**
 * 新建群状态前执行容量闸；超过 STATE_MANAGED_CHAT_LIMIT 直接拒绝，热读副本不淘汰权威记录。
 * @param chatId 待写入或创建的群 ID。
 */
export function assertChatStateCapacity(chatId: number): void {
  assertTelegramChatId(chatId, "chat state cache");
  if (!chatStateCache.has(chatId) && chatStateCache.size >= STATE_MANAGED_CHAT_LIMIT) {
    throw capacityError();
  }
}

/**
 * 获取主线程按群状态缓存的只读映射视图。
 *
 * @returns 群聊 ID 到群状态的只读 Map。
 */
export function getChatStateCache(): ReadonlyMap<number, ChatState> {
  return chatStateCache;
}

/**
 * 查找当前开启了代发模式（`isProxySendEnabled`）的目标群聊 ID。
 *
 * @returns 开启代发模式的群聊 ID；没有任何群开启时返回 `undefined`。
 */
export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStateCache) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
}

/**
 * 只读地查一个群的状态。没有条目时返回全局共享的 `DEFAULT_CHAT_STATE`，
 * 返回类型为 `Readonly<ChatState>`。要修改状态的调用方一律走 `getOrCreateChatState`。
 *
 * @param chatId 群聊 ID。
 * @returns 群状态的只读视图。
 */
export function getChatState(chatId: number): Readonly<ChatState> {
  return chatStateCache.get(chatId) ?? DEFAULT_CHAT_STATE;
}

/**
 * 取可写的群状态；没有条目时先过容量闸（`assertChatStateCapacity`），再以规范形状新建并登记。
 *
 * @param chatId 群聊 ID。
 * @returns 群状态的可写引用。
 */
export function getOrCreateChatState(chatId: number): ChatState {
  let chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (!chatState) {
    assertChatStateCapacity(chatId);
    // 规范形状一次建好；写入方只赋值，不往裸 `{}` 上一个个加字段（见
    // libs/chatState.ts 的 createChatState）。
    chatState = createChatState();
    chatStateCache.set(chatId, chatState);
  }
  return chatState;
}

/**
 * 收敛刚被清除字段的群状态；整条回到缺省时摘除热读副本条目。
 *
 * @param chatId 群聊 ID。
 * @param chatState 刚被修改的群状态对象。
 */
function settleClearedChatState(chatId: number, chatState: ChatState): void {
  normalizeChatState(chatState);
  if (isEmptyChatState(chatState)) chatStateCache.delete(chatId);
}

/**
 * 清除一个可选字段（置为 undefined）。字段本来就没设过时返回 false，不改动状态。
 * 调用方负责随后落盘。
 *
 * @param chatId 群聊 ID。
 * @param field 要清除的可选字段名。
 * @returns 实际清除了已有字段值时返回 `true`。
 */
export function clearChatStateField(chatId: number, field: ChatStateOptionalField): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[field] === undefined) return false;
  chatState[field] = undefined;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 关闭一个群开关（置为 false）。开关本来就是关闭时返回 false，不改动状态。
 * 调用方负责随后落盘。
 *
 * @param chatId 群聊 ID。
 * @param key 要关闭的布尔开关字段名。
 * @returns 实际将已开启开关置为关闭时返回 `true`。
 */
export function disableChatStateSwitch(chatId: number, key: ChatStateSwitchKey): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[key] !== true) return false;
  chatState[key] = false;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 停管一个群时删除它的全部配置，但保留尚需恢复的 lockdown write-ahead 记录。
 *
 * 两条路径共用：`/init disable`（见 commands/init.ts）与机器人被移出群（见
 * infra/botAdmin.ts）。lockdown 是唯一例外：反刷群恢复流程仍要用它的
 * originalPermissions 解锁（同 libs/chatState.ts 的 normalizeChatState）。
 *
 * 无记录时不做任何事；调用方负责在同一 teardown 尾部统一落盘。清完后若整条状态
 * 回到缺省，这里会删掉热读副本条目，随后的 persistChatState 写出删除墓碑，SQLite 行
 * 一并消失（见本模块的 encodeCurrentChatState）。
 *
 * @param chatId 群聊 ID。
 */
export function purgeChatStateExceptLockdown(chatId: number): void {
  const current: ChatState | undefined = chatStateCache.get(chatId);
  if (!current) return;
  if (current.lockdown === undefined) {
    chatStateCache.delete(chatId);
    return;
  }
  const retained: ChatState = createChatState();
  retained.lockdown = current.lockdown;
  chatStateCache.set(chatId, retained);
}

/**
 * 从热读副本读取指定群的当前状态并编码为 SQLite 写入载荷。
 * @param chatId 目标群 ID。
 * @returns 编码后的 JSON 字符串与是否应删除该群记录的标记。
 */
function encodeCurrentChatState(chatId: number): EncodedChatStateWrite {
  const state: ChatState | undefined = chatStateCache.get(chatId);
  if (state === undefined) return { data: null, deleted: true };
  normalizeChatState(state);
  if (isEmptyChatState(state)) return { data: null, deleted: true };
  return { data: encodeChatStateData(state, `chat state ${chatId}`), deleted: false };
}

/**
 * 把一群当前最终值排进 SQLite；返回本次 revision 供 durability barrier 核对。
 * @param chatId 目标群 ID。
 * @returns 本次写入分配的单调递增 revision。
 */
export function queueChatStateWrite(chatId: number): number {
  assertTelegramChatId(chatId, "chat state write");
  if (!Number.isSafeInteger(chatStateWriteRevision.current + 1)) {
    throw new Error("Chat-state revision space is exhausted.");
  }
  const encoded: EncodedChatStateWrite = encodeCurrentChatState(chatId);
  const revision: number = chatStateWriteRevision.current + 1;
  const message: ChatStateWriteDiskMessage = {
    type: "chatStateWrite",
    chatId,
    data: encoded.data,
    revision,
  };
  const cost: number = storageWriteCost(encoded.data);
  const previous: UnacknowledgedChatStateWrite | undefined = unacknowledgedChatStateWrites.get(chatId);
  const bytes: number = unacknowledgedChatStateBytes.current + cost - (previous?.bytes ?? 0);
  assertStorageAdmission(unacknowledgedChatStateWrites.size + (previous === undefined ? 1 : 0), bytes);
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused chat state publication.");
  // 准入通过后才摘除已空的群状态；闸抛错时热读副本与未 ACK 记账保持不变。
  if (encoded.deleted) chatStateCache.delete(chatId);
  chatStateWriteRevision.current = revision;
  unacknowledgedChatStateWrites.set(chatId, { revision, deleted: encoded.deleted, bytes: cost });
  unacknowledgedChatStateBytes.current = bytes;
  if (!postWithTransport(message)) {
    logger.error(
      `Failed to queue chat state ${chatId}; retaining revision ${revision} for replay.`
    );
  }
  return revision;
}

/**
 * 一群权威更新的 durable 屏障；目标 revision 收到精确事务 ACK 后才返回。
 * @param chatId 目标群 ID。
 * @param context 用于错误诊断的调用上下文说明。
 */
export async function persistChatState(chatId: number, context: string): Promise<void> {
  throwIfUpdateAborted();
  const revision: number = queueChatStateWrite(chatId);
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomain("chatState");
  throwIfUpdateAborted();
  if (outcome.result !== "flushed") {
    throw new Error(
      `Failed to persist chat state update (${context}): flush ${outcome.result} for ` +
      `chat ${chatId} revision ${revision}; ${describeFlushFailure(outcome)}.`
    );
  }
  if (unacknowledgedChatStateWrites.get(chatId)?.revision === revision) {
    throw new Error(
      `Failed to persist chat state update (${context}): Worker did not acknowledge ` +
      `chat ${chatId} revision ${revision}.`
    );
  }
}

/**
 * 低优先级群状态变化：入事务缓冲后立即返回，失败由统一重放与 flush 负责。
 * @param chatId 目标群 ID。
 * @param context 用于错误日志的调用上下文说明。
 */
export function saveChatStateInBackground(chatId: number, context: string): void {
  throwIfUpdateAborted();
  try {
    queueChatStateWrite(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to persist background chat state update (${context}):`, error);
  }
}

/**
 * 根据 Disk I/O Worker 的持久化回执消掉对应 revision 的未确认群状态写入记账。
 * @param reply Disk I/O Worker 返回的身份存储持久化回执。
 */
function settleChatStateWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.chatStateWrites) {
    const pending: UnacknowledgedChatStateWrite | undefined =
      unacknowledgedChatStateWrites.get(persisted.chatId);
    if (pending?.revision !== persisted.revision) continue;
    unacknowledgedChatStateWrites.delete(persisted.chatId);
    unacknowledgedChatStateBytes.current -= pending.bytes;
  }
}

/**
 * Disk I/O Worker 重生后按 revision 升序重放所有未确认的群状态写入。
 * @param transport 新一代 Disk I/O Worker 的恢复期投递通道。
 * @returns 全部未确认写入均成功投递时返回 true，中途投递失败时返回 false。
 */
function replayChatStateWrites(transport: DiskIORecoveryTransport): boolean {
  const writes: QueuedChatStateWrite[] = [];
  for (const [chatId, pending] of unacknowledgedChatStateWrites) {
    writes.push({ chatId, revision: pending.revision });
  }
  writes.sort((left: QueuedChatStateWrite, right: QueuedChatStateWrite): number =>
    left.revision - right.revision);
  for (const write of writes) {
    const encoded: EncodedChatStateWrite = encodeCurrentChatState(write.chatId);
    const current: UnacknowledgedChatStateWrite | undefined =
      unacknowledgedChatStateWrites.get(write.chatId);
    if (current?.revision !== write.revision) continue;
    const cost: number = storageWriteCost(encoded.data);
    if (current.deleted !== encoded.deleted || current.bytes !== cost) {
      unacknowledgedChatStateWrites.set(write.chatId, {
        revision: current.revision,
        deleted: encoded.deleted,
        bytes: cost,
      });
      unacknowledgedChatStateBytes.current += cost - current.bytes;
    }
    const message: ChatStateWriteDiskMessage = {
      type: "chatStateWrite",
      chatId: write.chatId,
      data: encoded.data,
      revision: write.revision,
    };
    if (!postWithTransport(message, transport)) return false;
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleChatStateWrites);
diskIO.onDiskIORespawn(
  "chat state",
  DISK_IO_RESPAWN_PRIORITIES.CHAT_STATE,
  replayChatStateWrites
);
