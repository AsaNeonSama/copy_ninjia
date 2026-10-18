import { readStoredAiContexts } from "./aiContext";
import { getTimeZone } from "../../config/time";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../consts/identityStorage";
import {
  BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE,
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
} from "../../consts/antiRaid/blocklist";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage,
  assertStorageDatabaseStartupJsonbStorage,
  assertStoredIdentityPolicies,
  readStorageDatabasePendingRemovalPage,
  readStorageDatabaseSchemaMetadata,
  readStorageDatabaseStartupRows,
} from "./inspection";
import {
  assertPendingRemovalBlocklistReferences,
  assertStorageTimeZone,
  decodeStoredChatStates,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  decodeStoredChatQa,
} from "../validation/storageRows";
import type { ChatState } from "../../types/chatState";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { DecodedPendingRemovalRows } from
  "../validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseStartupRows,
  StoredPendingRemovalRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";
import type { StorageDatabaseInspection } from "../../types/identityStorage";

type ValidatedPendingRemovalStartupRow =
  StoredPendingRemovalStartupRow & StoredPendingRemovalRow;

/** 校验分页存储形态并把 nullable 投影收窄为领域解码器接受的规范文本。 */
function assertPendingRemovalPage(
  rows: readonly StoredPendingRemovalStartupRow[],
  source: string
): asserts rows is readonly ValidatedPendingRemovalStartupRow[] {
  for (const row of rows) {
    if (row.storageClass !== "blob" || row.data === null) {
      throw new Error(
        `${source}:pending_blocked_removals[${row.removalId}].data: ` +
        "expected a BLOB containing strict SQLite JSONB."
      );
    }
  }
}

interface PendingRemovalInspection {
  readonly values: Map<number, PendingBlockedRemoval>;
}

/** 按主键游标分页读取并解码全部待踢任务行，校验总行数不超过 `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES`。 */
function inspectPendingRemovalPages(
  database: StorageDatabase,
  source: string
): PendingRemovalInspection {
  const values: Map<number, PendingBlockedRemoval> = new Map();
  let afterRemovalId: number | null = null;
  while (true) {
    const page: readonly StoredPendingRemovalStartupRow[] =
      readStorageDatabasePendingRemovalPage(database, afterRemovalId);
    if (values.size + page.length > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
      throw new Error(
        `${source}:pending_blocked_removals: ` +
        `expected at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows.`
      );
    }
    assertPendingRemovalPage(page, source);
    const removals: DecodedPendingRemovalRows = decodeStoredPendingRemovals(
      page,
      source
    );
    for (const [removalId, pending] of removals.values) {
      values.set(removalId, pending);
    }
    if (page.length < BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE) {
      return { values };
    }
    const last: StoredPendingRemovalStartupRow | undefined = page.at(-1);
    if (last === undefined) return { values };
    afterRemovalId = last.removalId;
  }
}

/** 执行共享存储数据库的启动全量校验，返回恢复快照与 AI 上下文映射。 */
export function validateStorageDatabase(database: StorageDatabase, source: string): StorageDatabaseInspection {
  assertStorageDatabaseStartupJsonbStorage(database, source);
  const metadata: readonly StoredStorageMetadataRow[] =
    readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion(
    { metadata },
    source
  );
  if (version !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      source + ": storage_metadata schema-version must be " +
      "{\"version\":" + String(IDENTITY_DATABASE_SCHEMA_VERSION) + "}."
    );
  }
  assertStorageTimeZone({ metadata }, source, getTimeZone());
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseMigrationLineage(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertStoredIdentityPolicies(database, source);
  const rows: StorageDatabaseStartupRows = readStorageDatabaseStartupRows(database);
  const removals: PendingRemovalInspection = inspectPendingRemovalPages(database, source);
  const chatStates: Map<number, ChatState> = decodeStoredChatStates(
    rows.chatStates,
    source
  );
  assertPendingRemovalBlocklistReferences(
    database,
    removals.values,
    source
  );
  const chatQaEntries: Map<number, ReadonlyMap<string, string>> = new Map(
    decodeStoredChatQa(rows.chatQa, source)
  );
  return {
    hydration: {
      blocklistEntryCount: rows.blocklistEntryCount,
      permissionEntryCount: rows.permissionEntryCount,
      pendingBlockedRemovals: removals.values,
      chatStates,
      chatQa: chatQaEntries,
    },
    aiMemories: readStoredAiContexts(database, source),
  };
}
