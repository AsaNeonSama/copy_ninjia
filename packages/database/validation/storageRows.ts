import {
  IDENTITY_DATABASE_METADATA_KEYS,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
} from "../../consts/identityStorage";
import { CHAT_QA_MAX_PER_CHAT } from "../../consts/qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { parseTimeZone } from "../../config/timeZoneInput";
import { assertChatQaQuestion, decodeChatQaData } from "../codec/chatQa";
import { assertTelegramChatId, decodeChatStateData } from "../codec/chatState";
import { decodePendingBlockedRemovalData } from "../codec/identity";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type { Statement } from "bun:sqlite";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type {
  StorageDatabase,
  StoredChatQaRow,
  StoredChatStateRow,
  StoredPendingRemovalRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

/** 构造 SQLite 业务行的校验错误来源路径（不包含行内容）。 */
export function storageRowSource(
  source: string,
  table: string,
  id: number | string
): string {
  const row: string = `${source}:${table}[${String(id)}]`;
  if (table === "temporary_ad_bypass_entries") return row;
  return `${row}.${table === "chat_states" ? "status" : table === "permission_list" ? "policy" : "data"}`;
}

/** `storage_metadata` 解码参数。 */
export interface ReadStorageMetadataParams {
  readonly metadata: readonly StoredStorageMetadataRow[];
}

/** 按主键查找唯一的 `storage_metadata` 行，缺失或重复时抛错。 */
function readOnlyMetadataRow(
  rows: ReadStorageMetadataParams,
  key: string,
  source: string
): StoredStorageMetadataRow {
  const matches: readonly StoredStorageMetadataRow[] =
    rows.metadata.filter((row: StoredStorageMetadataRow): boolean => row.key === key);
  const found: StoredStorageMetadataRow | undefined = matches[0];
  if (found === undefined || matches.length !== 1) {
    throw new Error(`${source}: storage_metadata must contain exactly one ${key} row.`);
  }
  return found;
}

/** 读取并校验 `storage_metadata` 中的 schema 版本号。 */
export function readStorageSchemaVersion(
  rows: ReadStorageMetadataParams,
  source: string
): number {
  const row: StoredStorageMetadataRow = readOnlyMetadataRow(
    rows,
    IDENTITY_DATABASE_SCHEMA_KEY,
    source
  );
  const value: unknown = parseJsonInput(
    row.data,
    storageRowSource(source, "storage_metadata", IDENTITY_DATABASE_SCHEMA_KEY)
  );
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version"]) ||
    !Number.isSafeInteger(value.version)
  ) {
    throw new Error(
      `${source}: storage_metadata schema-version must contain one safe integer version.`
    );
  }
  return value.version as number;
}

/** 校验 `storage_metadata` 主键集合与时区标记行跟当前配置时区一致。 */
export function assertStorageTimeZone(
  rows: ReadStorageMetadataParams,
  source: string,
  timeZone: string
): void {
  const row: StoredStorageMetadataRow = readOnlyMetadataRow(
    rows,
    IDENTITY_DATABASE_TIME_ZONE_KEY,
    source
  );
  for (const metadata of rows.metadata) {
    if (!IDENTITY_DATABASE_METADATA_KEYS.includes(metadata.key)) {
      throw new Error(
        `${source}: storage_metadata must contain only the ` +
        `${IDENTITY_DATABASE_METADATA_KEYS.join(" and ")} rows.`
      );
    }
  }
  const path: string = storageRowSource(source, "storage_metadata", IDENTITY_DATABASE_TIME_ZONE_KEY);
  const value: unknown = parseJsonInput(row.data, path);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["timeZone"]) ||
    parseTimeZone(value.timeZone, path, "$.timeZone") !== value.timeZone
  ) {
    return invalidInput(path, "$.timeZone", "a canonical IANA time zone name");
  }
  if (value.timeZone !== timeZone) {
    return invalidInput(
      source,
      `storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY}`,
      JSON.stringify({ timeZone })
    );
  }
}

/** 待踢任务行的解码结果。 */
export interface DecodedPendingRemovalRows {
  readonly values: ReadonlyMap<number, PendingBlockedRemoval>;
}

/** 严格解码待踢任务行并校验主键一致性。 */
export function decodeStoredPendingRemovals(
  rows: readonly StoredPendingRemovalRow[],
  source: string
): DecodedPendingRemovalRows {
  const values: Map<number, PendingBlockedRemoval> = new Map();
  for (const row of rows) {
    const path: string = storageRowSource(
      source,
      "pending_blocked_removals",
      row.removalId
    );
    if (!Number.isSafeInteger(row.removalId) || row.removalId < 1) {
      throw new Error(`${path}: removal_id must be a positive safe integer.`);
    }
    const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(row.data, path);
    if (pending.params.removalId !== row.removalId) {
      throw new Error(`${path}: params.removalId must equal the row primary key.`);
    }
    values.set(row.removalId, pending);
  }
  return { values };
}

/** 启动逐项核对 outbox 对黑名单的引用，不把完整黑名单复制进内存。 */
export function assertPendingRemovalBlocklistReferences(
  database: StorageDatabase,
  removals: ReadonlyMap<number, PendingBlockedRemoval>,
  source: string
): void {
  const anyBlocklistEntry: boolean = database.$client
    .query<{ readonly present: number }, []>(
      "SELECT 1 AS present FROM blocklist_entries LIMIT 1;"
    )
    .get() !== null;
  const lookup: Statement<{ readonly present: number }, [number]> =
    database.$client.query<{ readonly present: number }, [number]>(
      "SELECT 1 AS present FROM blocklist_entries WHERE id = ?1 LIMIT 1;"
    );
  for (const [removalId, pending] of removals) {
    const path: string = storageRowSource(
      source,
      "pending_blocked_removals",
      removalId
    );
    if (pending.params.probeMembership) {
      if (!anyBlocklistEntry) {
        throw new Error(`${path}: sweep requires at least one blocklist entry.`);
      }
    } else if (pending.params.userIds.some(
      (id: number): boolean => lookup.get(id) === null
    )) {
      throw new Error(`${path}: frozen userIds must all exist in blocklist_entries.`);
    }
  }
}

/**
 * 严格解码群状态，并执行 STATE_MANAGED_CHAT_LIMIT 群上限、唯一代理目标与「删除目标不含本群自身」约束。
 */
export function decodeStoredChatStates(
  rows: readonly StoredChatStateRow[],
  source: string
): Map<number, ChatState> {
  if (rows.length > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${source}:chat_states must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
      "delete chats that are no longer managed before starting the bot."
    );
  }
  const chatStates: Map<number, ChatState> = new Map();
  let proxyTargetChatId: number | undefined;
  for (const row of rows) {
    const path: string = storageRowSource(source, "chat_states", row.chatId);
    assertTelegramChatId(row.chatId, path);
    if (chatStates.has(row.chatId)) {
      throw new Error(`${path}: duplicate chat primary key.`);
    }
    const state: ChatState = decodeChatStateData(row.data, path);
    const ownIdIndex: number = state.deleteMessageTargets?.indexOf(row.chatId) ?? -1;
    if (ownIdIndex >= 0) {
      throw new Error(
        `${path}: $.deleteMessageTargets[${ownIdIndex}] must be a user or channel ID other than the chat itself.`
      );
    }
    if (state.isProxySendEnabled === true) {
      if (proxyTargetChatId !== undefined) {
        throw new Error(
          `${source}:chat_states must contain at most one active proxy send target.`
        );
      }
      proxyTargetChatId = row.chatId;
    }
    chatStates.set(row.chatId, state);
  }
  return chatStates;
}

/**
 * 严格解码全部问答行，并核对每群条数不超过 CHAT_QA_MAX_PER_CHAT。
 *
 * @returns 群 -> 问题 -> 答案；调用方据此重建热缓存。
 */
export function decodeStoredChatQa(
  rows: readonly StoredChatQaRow[],
  source: string
): ReadonlyMap<number, ReadonlyMap<string, string>> {
  const byChat: Map<number, Map<string, string>> = new Map();
  for (const row of rows) {
    const path: string = storageRowSource(source, "chat_qa", `${row.chatId}:${row.q}`);
    assertTelegramChatId(row.chatId, path);
    assertChatQaQuestion(row.q, path);
    const existing: Map<string, string> | undefined = byChat.get(row.chatId);
    const questions: Map<string, string> = existing ?? new Map<string, string>();
    if (existing === undefined) byChat.set(row.chatId, questions);
    questions.set(row.q, decodeChatQaData(row.data, path).a);
    if (questions.size > CHAT_QA_MAX_PER_CHAT) {
      throw new Error(
        `${path}: chat_qa must contain at most ${CHAT_QA_MAX_PER_CHAT} entries per chat.`
      );
    }
  }
  return byChat;
}
