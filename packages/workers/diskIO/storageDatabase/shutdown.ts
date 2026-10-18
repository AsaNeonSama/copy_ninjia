/**
 * 停机时关闭共享 SQLite：提交残余写、执行 `PRAGMA wal_checkpoint(TRUNCATE)` 并关闭连接。
 */

import {
  storageDatabaseClosed,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../cache/workers/diskIO/storageDatabase";
import { closeStorageDatabase } from "../../../database/interact/connection";
import type { IdentityPersistenceReply, StorageCloseOutcome } from "../../../types/diskIO/replies";
import type { StorageDatabase } from "../../../types/storageDatabase";
import { flushStorageDatabase } from "./flush";
import { requireStorageDatabase } from "./context";

/** `PRAGMA wal_checkpoint` 的返回行结构；busy 非零表示存在阻塞导致 WAL 未完整截断。 */
interface WalCheckpointRow {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

/** 提交残余事务、执行 TRUNCATE checkpoint 并关闭数据库连接。 */
export function closeStorageDatabaseForShutdown(reply: IdentityPersistenceReply): StorageCloseOutcome {
  const database: StorageDatabase = requireStorageDatabase();
  const committed: boolean = flushStorageDatabase(reply);
  storageDatabaseClosed.current = true;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  storageDatabaseHandle.current = null;
  try {
    const row: WalCheckpointRow | null = database.$client
      .query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE);")
      .get();
    return { committed, checkpointBusy: row?.busy !== 0 };
  } finally {
    closeStorageDatabase(database);
  }
}
