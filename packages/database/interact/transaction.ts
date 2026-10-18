import { and, eq, sql } from "drizzle-orm";
import { chatQa } from "../schema/chatQa";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  StorageAiContextChange,
  StorageDatabase,
  StorageDatabaseChange,
  StorageDatabaseWriter,
} from "../../types/storageDatabase";
import type { PendingTemporaryAdBypassWrite } from
  "../../types/temporaryAdBypass";

export interface CommitStorageDatabaseChangesOptions {
  readonly whitelist: ReadonlyMap<number, StorageDatabaseChange>;
  readonly blocklist: ReadonlyMap<number, StorageDatabaseChange>;
  readonly temporaryAdBypass: ReadonlyMap<number, PendingTemporaryAdBypassWrite>;
  readonly removals: ReadonlyMap<number, StorageDatabaseChange>;
  readonly chatStates: ReadonlyMap<number, StorageDatabaseChange>;
  /** 群问答按 (chatId, q) 复合主键变更；外层键为 chatId，内层键为问题文本 q。 */
  readonly chatQa: ReadonlyMap<number, ReadonlyMap<string, StorageDatabaseChange>>;
  /** AI 上下文按群主键只更新 `ai_context` 列；排在群状态之后，群行不存在时不插入。 */
  readonly aiContexts: ReadonlyMap<number, StorageAiContextChange>;
}

/** 生成将命名占位符绑定值转为 SQLite JSONB 的 SQL 表达式。 */
function jsonbPlaceholder(name: string): SQL {
  return sql`jsonb(${sql.placeholder(name)})`;
}

/** 生成引用 upsert 冲突行同名列值的 SQL 表达式。 */
function excluded(column: SQLiteColumn): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** 为指定数据库连接预编译事务提交所需的全部 upsert、delete 与 update 语句。 */
export function prepareStorageDatabaseWriter(database: StorageDatabase): StorageDatabaseWriter {
  return {
    database,
    upsertWhitelist: database.insert(permissionList)
      .values({ id: sql.placeholder("id"), data: jsonbPlaceholder("data") })
      .onConflictDoUpdate({ target: permissionList.id, set: { data: excluded(permissionList.data) } })
      .prepare(),
    deleteWhitelist: database.delete(permissionList)
      .where(eq(permissionList.id, sql.placeholder("id"))).prepare(),
    upsertBlocklist: database.insert(blocklistEntries)
      .values({ id: sql.placeholder("id"), data: jsonbPlaceholder("data") })
      .onConflictDoUpdate({ target: blocklistEntries.id, set: { data: excluded(blocklistEntries.data) } })
      .prepare(),
    deleteBlocklist: database.delete(blocklistEntries)
      .where(eq(blocklistEntries.id, sql.placeholder("id"))).prepare(),
    upsertTemporaryAdBypass: database.insert(temporaryAdBypassEntries)
      .values({
        id: sql.placeholder("id"),
        adBypass: sql.placeholder("adBypass"),
        adBypassGrantedAt: sql.placeholder("adBypassGrantedAt"),
        qualifiedDays: sql.placeholder("qualifiedDays"),
        sendCount: sql.placeholder("sendCount"),
        countedAt: sql.placeholder("countedAt"),
        qualifiedAt: sql.placeholder("qualifiedAt"),
      })
      .onConflictDoUpdate({
        target: temporaryAdBypassEntries.id,
        set: {
          adBypass: excluded(temporaryAdBypassEntries.adBypass),
          adBypassGrantedAt: excluded(temporaryAdBypassEntries.adBypassGrantedAt),
          qualifiedDays: excluded(temporaryAdBypassEntries.qualifiedDays),
          sendCount: excluded(temporaryAdBypassEntries.sendCount),
          countedAt: excluded(temporaryAdBypassEntries.countedAt),
          qualifiedAt: excluded(temporaryAdBypassEntries.qualifiedAt),
        },
      })
      .prepare(),
    deleteTemporaryAdBypass: database.delete(temporaryAdBypassEntries)
      .where(eq(temporaryAdBypassEntries.id, sql.placeholder("id"))).prepare(),
    upsertRemoval: database.insert(pendingBlockedRemovals)
      .values({ removalId: sql.placeholder("id"), data: jsonbPlaceholder("data") })
      .onConflictDoUpdate({
        target: pendingBlockedRemovals.removalId,
        set: { data: excluded(pendingBlockedRemovals.data) },
      })
      .prepare(),
    deleteRemoval: database.delete(pendingBlockedRemovals)
      .where(eq(pendingBlockedRemovals.removalId, sql.placeholder("id"))).prepare(),
    upsertChatState: database.insert(chatStates)
      .values({ chatId: sql.placeholder("id"), status: jsonbPlaceholder("data") })
      .onConflictDoUpdate({
        target: chatStates.chatId,
        set: { status: excluded(chatStates.status) },
      })
      .prepare(),
    deleteChatState: database.delete(chatStates)
      .where(eq(chatStates.chatId, sql.placeholder("id"))).prepare(),
    upsertChatQa: database.insert(chatQa)
      .values({ chatId: sql.placeholder("id"), q: sql.placeholder("q"), data: jsonbPlaceholder("data") })
      .onConflictDoUpdate({ target: [chatQa.chatId, chatQa.q], set: { data: excluded(chatQa.data) } })
      .prepare(),
    deleteChatQa: database.delete(chatQa)
      .where(and(eq(chatQa.chatId, sql.placeholder("id")), eq(chatQa.q, sql.placeholder("q")))).prepare(),
    updateAiContext: database.update(chatStates)
      .set({ aiContext: jsonbPlaceholder("data") })
      .where(eq(chatStates.chatId, sql.placeholder("id"))).prepare(),
  };
}

/** 在单个事务中按固定表顺序批量执行各业务表的增删改预编译语句（`chat_states` 先于 `ai_context` 更新）。 */
export function commitStorageDatabaseChanges(
  writer: StorageDatabaseWriter,
  {
    whitelist,
    blocklist,
    temporaryAdBypass,
    removals,
    chatStates: chatStateChanges,
    chatQa: chatQaChanges,
    aiContexts,
  }: CommitStorageDatabaseChangesOptions
): void {
  writer.database.transaction((): void => {
    for (const [id, change] of whitelist) {
      if (change.data === null) writer.deleteWhitelist.run({ id });
      else writer.upsertWhitelist.run({ id, data: change.data });
    }
    for (const [id, change] of blocklist) {
      if (change.data === null) writer.deleteBlocklist.run({ id });
      else writer.upsertBlocklist.run({ id, data: change.data });
    }
    for (const [id, change] of temporaryAdBypass) {
      const activity: PendingTemporaryAdBypassWrite["activity"] = change.activity;
      if (activity === null) {
        writer.deleteTemporaryAdBypass.run({ id });
      } else {
        writer.upsertTemporaryAdBypass.run({
          id,
          adBypass: activity.adBypass,
          adBypassGrantedAt: activity.adBypassGrantedAt,
          qualifiedDays: activity.qualifiedDays,
          sendCount: activity.sendCount,
          countedAt: activity.countedAt,
          qualifiedAt: activity.qualifiedAt,
        });
      }
    }
    for (const [removalId, change] of removals) {
      if (change.data === null) writer.deleteRemoval.run({ id: removalId });
      else writer.upsertRemoval.run({ id: removalId, data: change.data });
    }
    for (const [chatId, change] of chatStateChanges) {
      if (change.data === null) writer.deleteChatState.run({ id: chatId });
      else writer.upsertChatState.run({ id: chatId, data: change.data });
    }
    for (const [chatId, questions] of chatQaChanges) {
      for (const [q, change] of questions) {
        if (change.data === null) writer.deleteChatQa.run({ id: chatId, q });
        else writer.upsertChatQa.run({ id: chatId, q, data: change.data });
      }
    }
    for (const [chatId, change] of aiContexts) {
      writer.updateAiContext.run({ id: chatId, data: change.snapshot });
    }
  });
}
