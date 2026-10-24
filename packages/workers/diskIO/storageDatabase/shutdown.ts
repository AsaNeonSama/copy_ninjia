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
  /** 非零表示存在其他连接阻塞 checkpoint。 */
  readonly busy: number;
  /** WAL 文件中的总帧数（未被完全截断时大于 0）。 */
  readonly log: number;
  /** 已成功写回主数据库文件的帧数。 */
  readonly checkpointed: number;
}

/**
 * 提交残余事务、执行 TRUNCATE checkpoint 并关闭数据库连接。
 * @param reply 持久化回执发送回调
 * @returns 残余写提交结果与 WAL checkpoint 是否阻塞
 */
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
