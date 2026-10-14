import { and, isNull, lt, or } from "drizzle-orm";
import { getDayStartTimestamp } from "../../libs/time";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { StorageDatabase, StorageDatabaseReader } from "../../types/storageDatabase";
import type { StoredTemporaryAdBypassActivity } from "../../types/temporaryAdBypass";

/** 通过预编译语句按 ID 列表批量读取临时广告免检已提交行（单批不超过 IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES）。 */
export function readStoredTemporaryAdBypassActivities(
  reader: StorageDatabaseReader,
  ids: readonly number[]
): readonly StoredTemporaryAdBypassActivity[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Temporary ad bypass reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return reader.temporaryAdBypassActivities.all({ ids: JSON.stringify(ids) });
}

/** 删除 `counted_at` 早于当日零点且未在上一自然日达标的临时广告免检行。 */
export function deleteStaleTemporaryAdBypassActivities(
  database: StorageDatabase,
  currentDayStart: number,
  previousDayStart: number
): void {
  if (
    !Number.isSafeInteger(currentDayStart) ||
    !Number.isSafeInteger(previousDayStart) ||
    previousDayStart < 0 ||
    currentDayStart <= previousDayStart ||
    getDayStartTimestamp(currentDayStart) !== currentDayStart ||
    getDayStartTimestamp(currentDayStart - 1) !== previousDayStart
  ) {
    throw new RangeError("Temporary ad bypass cleanup day bounds must be adjacent local day starts as non-negative safe integers.");
  }
  database.delete(temporaryAdBypassEntries)
    .where(and(
      lt(temporaryAdBypassEntries.countedAt, currentDayStart),
      or(
        isNull(temporaryAdBypassEntries.qualifiedAt),
        lt(temporaryAdBypassEntries.qualifiedAt, previousDayStart)
      )
    )).run();
}
