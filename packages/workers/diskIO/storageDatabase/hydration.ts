import {
  removalRowTargets,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { closeStorageDatabase, openStorageDatabase } from "../../../database/interact/connection";
import { validateStorageDatabase } from "../../../database/interact/validation";
import type { StorageDatabase } from "../../../types/storageDatabase";
import type { StorageDatabaseHydration, StorageDatabaseInspection } from "../../../types/identityStorage";

/**
 * 跨域启动第一阶段：以只读连接严格校验并重建有限快照。
 * @returns 校验通过的数据库检查结果
 */
export function inspectStorageDatabase(): StorageDatabaseInspection {
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    readonly: true,
    requireWritableAccess: true,
  });
  try {
    return validateStorageDatabase(database, IDENTITY_DATABASE_PATH);
  } finally {
    closeStorageDatabase(database);
  }
}

/**
 * 全域 inspect 成功后打开唯一可写连接，并由校验过的 outbox 行建立 removalRowTargets。
 * @param inspection 启动第一阶段生成的数据库检查结果
 * @returns 供主线程与 Worker 水合的快照载荷
 */
export function adoptStorageDatabase(
  inspection: StorageDatabaseInspection
): StorageDatabaseHydration {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    requireWritableAccess: true,
  });
  storageDatabaseHandle.current = database;
  for (const [removalId, pending] of inspection.hydration.pendingBlockedRemovals) {
    removalRowTargets.set(removalId, pending.params.probeMembership
      ? { probeMembership: true, userIds: [] }
      : { probeMembership: false, userIds: pending.params.userIds });
  }
  return inspection.hydration;
}
