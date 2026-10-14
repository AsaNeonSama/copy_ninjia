import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StorageDatabaseReader,
  StoredChatStateRow,
} from "../../types/storageDatabase";

/** 通过连接级预编译语句读取 `chat_states` 全部已提交群主键。 */
export function readStoredChatStateIds(
  reader: StorageDatabaseReader
): readonly Pick<StoredChatStateRow, "chatId">[] {
  return reader.chatStateIds.all();
}

/** 读取 `chat_states` 全表已提交行。 */
export function readStoredChatStates(
  database: StorageDatabase
): readonly StoredChatStateRow[] {
  return database
    .select({ chatId: chatStates.chatId, data: jsonbTextProjection(chatStates.status) })
    .from(chatStates)
    .all();
}
