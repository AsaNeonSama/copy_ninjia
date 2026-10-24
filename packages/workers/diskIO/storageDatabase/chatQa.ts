import {
  storagePendingBudgets,
  pendingChatQaEntryCount,
  pendingChatQaWrites,
  storageFlushHold,
} from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { CHAT_QA_MAX_PER_CHAT } from "../../../consts/qa";
import { assertChatQaQuestion, decodeChatQaData } from "../../../database/codec/chatQa";
import { assertTelegramChatId } from "../../../database/codec/chatState";
import { readStoredChatQaQuestions } from "../../../database/interact/chatQa";
import type {
  ChatQaWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type {
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import type { PendingChatQaWrite } from "../../../types/identityStorage";
import type { StoredChatQaRow } from "../../../types/storageDatabase";
import { assertPositiveRevision, requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

/**
 * 读取指定群已提交问题并叠加待提交变更，返回有效问题集合。
 * @param chatId 目标群 ID。
 * @returns 叠加未提交事务缓冲后的有效问答问题集合。
 */
function effectiveChatQaQuestions(chatId: number): Set<string> {
  const rows: readonly Pick<StoredChatQaRow, "q">[] = readStoredChatQaQuestions(
    requireStorageDatabase(),
    chatId
  );
  const questions: Set<string> = new Set<string>();
  for (const row of rows) questions.add(row.q);
  const pending: Map<string, PendingChatQaWrite> | undefined =
    pendingChatQaWrites.get(chatId);
  if (pending !== undefined) {
    for (const [q, write] of pending) {
      if (write.data === null) questions.delete(q);
      else questions.add(q);
    }
  }
  return questions;
}

/**
 * 校验指定群的有效问题集合不超过单群条数上限。
 * @param effective 叠加未提交变更后的有效问题集合。
 */
function assertChatQaCapacity(effective: ReadonlySet<string>): void {
  if (effective.size > CHAT_QA_MAX_PER_CHAT) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:chat_qa must contain at most ` +
      `${CHAT_QA_MAX_PER_CHAT} entries per chat; remove one before adding another.`
    );
  }
}

/** 镜像重放结束时统一复核所有存在待提交问答变更的群条数上限。 */
export function assertPendingChatQaCapacity(): void {
  for (const chatId of pendingChatQaWrites.keys()) {
    assertChatQaCapacity(effectiveChatQaQuestions(chatId));
  }
}

/**
 * 校验并接收一条群问答写入，验证单群条数上限（镜像重放暂挂期间延后至重放结束统一复核）后排入事务缓冲。
 * @param message 群问答写入或删除请求消息。
 * @param reply 向主线程发送持久化回执的出口。
 */
export function handleChatQaWrite(
  message: ChatQaWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const rowSource: string = storageSource("chat_qa", message.chatId);
  assertTelegramChatId(message.chatId, rowSource);
  assertChatQaQuestion(message.q, rowSource);
  assertPositiveRevision(message.revision, rowSource);
  if (message.data !== null) decodeChatQaData(message.data, rowSource);

  const questions: Map<string, PendingChatQaWrite> =
    pendingChatQaWrites.get(message.chatId) ?? new Map<string, PendingChatQaWrite>();
  const current: PendingChatQaWrite | undefined = questions.get(message.q);
  if (current !== undefined && current.revision >= message.revision) return;

  if (!storageFlushHold.current) {
    const effective: Set<string> = effectiveChatQaQuestions(message.chatId);
    if (message.data === null) effective.delete(message.q);
    else effective.add(message.q);
    assertChatQaCapacity(effective);
  }

  storagePendingBudgets.chatQa.reserve(current === undefined ? 1 : 0, storageWriteCost(message.data, message.q) - (current === undefined ? 0 : storageWriteCost(current.data, message.q)));
  questions.set(message.q, { data: message.data, revision: message.revision });
  if (current === undefined) pendingChatQaEntryCount.current++;
  pendingChatQaWrites.set(message.chatId, questions);
  flushIfStorageFull(reply);
}
