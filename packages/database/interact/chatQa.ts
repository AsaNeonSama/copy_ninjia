import { eq } from "drizzle-orm";
import { chatQa } from "../schema/chatQa";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StoredChatQaRow,
} from "../../types/storageDatabase";

/** 读取 `chat_qa` 全表已提交行。 */
export function readStoredChatQa(
  database: StorageDatabase
): readonly StoredChatQaRow[] {
  return database
    .select({
      chatId: chatQa.chatId,
      q: chatQa.q,
      data: jsonbTextProjection(chatQa.data),
    })
    .from(chatQa)
    .all();
}

/** 读取指定群在 `chat_qa` 中已提交的全部问题主键。 */
export function readStoredChatQaQuestions(
  database: StorageDatabase,
  chatId: number
): readonly Pick<StoredChatQaRow, "q">[] {
  return database
    .select({ q: chatQa.q })
    .from(chatQa)
    .where(eq(chatQa.chatId, chatId))
    .all();
}
