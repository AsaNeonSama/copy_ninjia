import { IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { encodeWhitelistEntryData } from "../../packages/database/codec/identity";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { resetStorageDatabaseCache } from "../../packages/cache/workers/diskIO/storageDatabase";
import {
  adoptStorageDatabase,
  inspectStorageDatabase,
} from "../../packages/workers/diskIO/storageDatabase/hydration";
import { clearStorageBusinessTables } from "../../scripts/fixtures/storageDatabase";
import type { IdentityPolicyWriteDiskMessage } from "../../packages/types/diskIO";
import type { WhitelistEntryData } from "../../packages/types/identityPolicy";
import type { StorageDatabaseHydration } from "../../packages/types/identityStorage";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

const TEST_WHITELIST_META: Readonly<{ firstName: string; lastName: string; username: string }> = {
  firstName: "本天才才不是雑魚喵~",
  lastName: "",
  username: "copy_ninjia_bot",
};

/**
 * 单领域恢复：生产启动编排走 inspect/adopt 两阶段（跨域先全部 inspect 再统一
 * adopt，见 workers/diskIO/startup.ts），只有用例需要把两步并成一次调用。
 */
export function hydrateStorageDatabase(): StorageDatabaseHydration {
  return adoptStorageDatabase(inspectStorageDatabase());
}

/** 构造带默认权限的 whitelist identityPolicyWrite 测试消息。 */
export function whitelistWrite(id: number, revision: number): IdentityPolicyWriteDiskMessage {
  const value: WhitelistEntryData = {
    permissions: DEFAULT_WHITELIST_PERMISSIONS,
    meta: TEST_WHITELIST_META,
  };
  return {
    type: "identityPolicyWrite",
    table: "whitelist",
    id,
    data: encodeWhitelistEntryData(value),
    revision,
  };
}

/** 清空 SQLite 内存缓存与全部业务表，并完成一次启动恢复。 */
export function resetDatabaseFixture(): void {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
  });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  hydrateStorageDatabase();
}
