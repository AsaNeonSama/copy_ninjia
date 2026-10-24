import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { IDENTITY_WRITE_BATCH_MAX_ENTRIES } from "../../../packages/consts/identityStorage";
import { storageDatabaseHandle, resetStorageDatabaseCache } from "../../../packages/cache/workers/diskIO/storageDatabase";
import { openStorageDatabase } from "../../../packages/database/interact/connection";
import { bootstrapStorageDatabase } from "../../../packages/database/interact/initialization";
import { DEFAULT_BOT_TIME_ZONE } from "../../../packages/consts/bot";
import { handleTemporaryAdBypassWrite } from "../../../packages/workers/diskIO/storageDatabase/temporaryAdBypass";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import type { IdentityStoragePersistedReply } from "../../../packages/types/diskIO/replies";
import { assertInsidePerformanceMockRoot } from "../fullSuite/mockRoot";
import type { Scenario } from "./types";

/**
 * 真正的 SQLite 批量写入和精确 ACK；库按生产建库入口建立（WAL），每次迭代提交一个生产容量的事务。
 *
 * @returns SQLite 身份库批量刷盘与确认场景定义
 */
export function storageFlushScenario(): Scenario {
  assertInsidePerformanceMockRoot(IDENTITY_DATABASE_PATH);
  mkdirSync(dirname(IDENTITY_DATABASE_PATH), { recursive: true });
  if (!existsSync(IDENTITY_DATABASE_PATH)) bootstrapStorageDatabase(IDENTITY_DATABASE_PATH, DEFAULT_BOT_TIME_ZONE);
  let confirmed: number = 0;
  let revision: number = 0;
  /**
   * 累加已落盘的临时广告免检写入回执条数。
   *
   * @param value Disk I/O Worker 发出的持久化确认回执
   */
  function reply(value: IdentityStoragePersistedReply): void { confirmed += value.temporaryAdBypassWrites.length; }
  return {
    iterations: 1_000,
    prepare: (): void => { storageDatabaseHandle.current = openStorageDatabase({ path: IDENTITY_DATABASE_PATH }); },
    run: (iterations: number): number => {
      const before: number = confirmed;
      for (let index: number = 0; index < iterations; index++) {
        for (let id: number = 1; id <= IDENTITY_WRITE_BATCH_MAX_ENTRIES; id++) {
          handleTemporaryAdBypassWrite({ type: "temporaryAdBypassWrite", id, activity: null, revision: ++revision }, reply);
        }
      }
      if (confirmed - before !== iterations * IDENTITY_WRITE_BATCH_MAX_ENTRIES) throw new Error("SQLite benchmark omitted durable acknowledgements.");
      return confirmed - before;
    },
    reset: (): void => { resetStorageDatabaseCache(); confirmed = 0; revision = 0; },
    probes: { handleTemporaryAdBypassWrite, flushStorageDatabase },
  };
}
