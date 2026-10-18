/** 贴纸目录快照与每日运势的严格文件恢复、校验与落盘。 */

import { mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DayFileState, LuckDayCache, LuckDrawRecord, LuckPendingEntry } from "../../types/diskIO/storage";
import type { StickerCatalogSnapshot } from "../../types/stickers/catalog";
import type { LuckTier } from "../../types/luckChallenge";
import {
  LUCK_MEMORY_DIR,
  LUCK_RECEIPT_SECRET_PATH,
  STICKER_MEMORY_DIR,
} from "../../consts/paths";
import { DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { STICKER_PACK_NAME_PATTERN } from "../../consts/aiChat/stickers";
import { DAILY_LUCK_CACHE_MAX, luckTierByLabel } from "../../consts/luckChallenge";
import { LUCK_CACHE_KEY_PATTERN } from "../../consts/luckReceipt";
import {
  appendToDayFile,
  openDayFile,
  openValidatedAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import { atomicWriteTextSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { invalidInput, readJsonInput, readUtf8TextInput } from "../../libs/inputValidation";
import {
  decodeStickerCatalogSnapshot,
} from "../../libs/persistedSnapshotCodec";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";
import { assertFileReadableWritable, bestEffortUnlink, inspectOptionalFile, listOptionalDirectory } from "../../libs/fileAccess";

/** 贴纸目录快照的 inspect 结果：待载入的快照、孤儿快照路径与供清理 *.tmp 残留的目录项。 */
export interface StickerCatalogRecoveryInspection {
  readonly snapshots: Map<string, string>;
  readonly orphanPaths: readonly string[];
  readonly names: readonly string[];
}

/**
 * 只读扫描并严格校验贴纸目录快照，按 activePacks 拆分为待载入快照与孤儿文件路径（activePacks 为 null 时不判孤儿）。
 */
export async function inspectStickerCatalogs(
  activePacks: readonly string[] | null
): Promise<StickerCatalogRecoveryInspection> {
  const activePackSet: Set<string> | null = activePacks === null ? null : new Set(activePacks);
  const result: Map<string, string> = new Map();
  const orphanPaths: string[] = [];
  const names: readonly string[] = listOptionalDirectory(STICKER_MEMORY_DIR);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path: string = join(STICKER_MEMORY_DIR, name);
    const pack: string = name.slice(0, -".json".length);
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(path, "$filename", "the canonical <stickerPackShortName>.json form");
    }
    assertFileReadableWritable(path);
    const parsed: unknown = await readJsonInput(path);
    const snapshot: StickerCatalogSnapshot = decodeStickerCatalogSnapshot(parsed, path);
    if (activePackSet !== null && !activePackSet.has(pack)) {
      orphanPaths.push(path);
      continue;
    }
    result.set(pack, JSON.stringify(snapshot, null, 2));
  }
  return { snapshots: result, orphanPaths, names };
}

/** 全域校验成功后清理临时文件与已退出白名单的孤儿快照。 */
export async function maintainStickerCatalogFiles(
  inspection: StickerCatalogRecoveryInspection
): Promise<void> {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  await removeOrphanedTempFiles(STICKER_MEMORY_DIR, inspection.names);
  for (const path of inspection.orphanPaths) await bestEffortUnlink(path);
}

/** 原子覆盖写入单个贴纸包的目录快照 JSON。 */
export function writeStickerCatalogFile(pack: string, snapshotJson: string): void {
  mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(STICKER_MEMORY_DIR, `${pack}.json`), snapshotJson, PERSISTED_FILE_MODE);
}

/** 校验运势目录下的按日文件名，返回早于 todayKey 的过期文件路径列表。 */
function inspectStaleLuckFiles(
  todayKey: string,
  names: readonly string[]
): readonly string[] {
  const stalePaths: string[] = [];
  for (const name of names) {
    if (name === basename(LUCK_RECEIPT_SECRET_PATH)) continue;
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(name);
    if (match === null) {
      if (name.endsWith(".json")) {
        return invalidInput(
          join(LUCK_MEMORY_DIR, name),
          "$filename",
          "the canonical <YYYY-MM-DD>.json form"
        );
      }
      continue;
    }
    const day: string = match[1]!;
    const path: string = join(LUCK_MEMORY_DIR, name);
    if (!isCanonicalDateKey(day)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (day > todayKey) {
      return invalidInput(path, "$filename", "a date no later than the current configured local day");
    }
    if (day < todayKey) stalePaths.push(path);
  }
  return stalePaths;
}

export async function cleanupStaleLuckFiles(
  todayKey: string,
  names: readonly string[] = readdirSync(LUCK_MEMORY_DIR)
): Promise<void> {
  for (const path of inspectStaleLuckFiles(todayKey, names)) await bestEffortUnlink(path);
}

export interface LuckFileStateHolder {
  current: DayFileState | null;
}

export interface LuckDayRecoveryInspection {
  readonly day: string;
  readonly cache: LuckDayCache | null;
  readonly fileState: DayFileState | null;
  readonly names: readonly string[];
}

/** 只读校验运势目录文件名并恢复 todayKey 当天的运势结果与追加游标。 */
export async function inspectLuckDay(
  todayKey: string
): Promise<LuckDayRecoveryInspection> {
  const names: string[] = listOptionalDirectory(LUCK_MEMORY_DIR);
  inspectStaleLuckFiles(todayKey, names);
  const todayPath: string = join(LUCK_MEMORY_DIR, `${todayKey}.json`);
  if (!inspectOptionalFile(todayPath)) {
    return { day: todayKey, cache: null, fileState: null, names };
  }
  let content: string;
  let parsed: unknown;
  try {
    content = await readUtf8TextInput(todayPath);
    parsed = JSON.parse(content) as unknown;
  } catch {
    return invalidInput(todayPath, "$", "a readable valid JSON document");
  }
  if (!isPlainRecord(parsed)) {
    return invalidInput(todayPath, "$", "a JSON object keyed by canonical luck cache keys");
  }
  const raw: Record<string, unknown> = parsed;
  let entryCount: number = 0;
  const entries: Map<string, LuckDrawRecord> = new Map();
  let failurePath: string | null = null;
  let failureExpected: string = "";
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    entryCount++;
    if (failurePath !== null) continue;
    const value: unknown = raw[key];
    if (!LUCK_CACHE_KEY_PATTERN.test(key)) {
      failurePath = "$.<key>";
      failureExpected = "a canonical luck cache key";
      continue;
    }
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["label", "fortunePercent"]) ||
      typeof value.label !== "string" ||
      typeof value.fortunePercent !== "number" ||
      !Number.isFinite(value.fortunePercent)
    ) {
      failurePath = "$.<record>";
      failureExpected = "exactly { label: string, fortunePercent: finiteNumber }";
      continue;
    }
    const tier: LuckTier | undefined = luckTierByLabel(value.label);
    if (tier === undefined) {
      failurePath = "$.<record>.label";
      failureExpected = "a current luck tier label";
      continue;
    }
    const [minimum, maximum]: readonly [number, number] = tier.fortunePercentRange;
    if (value.fortunePercent < minimum || value.fortunePercent > maximum) {
      failurePath = "$.<record>.fortunePercent";
      failureExpected = "within the selected tier range";
      continue;
    }
    entries.set(key, { label: value.label, fortunePercent: value.fortunePercent });
  }
  if (entryCount > DAILY_LUCK_CACHE_MAX) {
    return invalidInput(todayPath, "$", `at most ${DAILY_LUCK_CACHE_MAX} confirmed luck records`);
  }
  if (failurePath !== null) return invalidInput(todayPath, failurePath, failureExpected);
  const opened: DayFileState = {
    day: todayKey,
    ...openValidatedAppendOnlyFile({
      path: todayPath,
      content,
      empty: entryCount === 0,
    }),
  };
  return {
    day: todayKey,
    cache: { day: todayKey, entries },
    fileState: opened,
    names,
  };
}

/** 全域校验成功后创建目录，并清理临时文件与过期日文件。 */
export async function maintainLuckDay(
  todayKey: string,
  inspection: LuckDayRecoveryInspection
): Promise<void> {
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  await removeOrphanedTempFiles(LUCK_MEMORY_DIR, inspection.names);
  await cleanupStaleLuckFiles(todayKey, inspection.names);
}

/** 单领域恢复入口；跨域启动编排使用 inspect/adopt/maintenance 三阶段 API。 */
export async function recoverLuckDay(
  todayKey: string,
  fileState?: LuckFileStateHolder
): Promise<LuckDayCache | null> {
  const inspection: LuckDayRecoveryInspection = await inspectLuckDay(todayKey);
  await maintainLuckDay(todayKey, inspection);
  if (fileState !== undefined) fileState.current = inspection.fileState;
  return inspection.cache;
}

/** 将一批确认的运势条目按位置追加到当日文件末尾。 */
export async function appendLuckEntries(
  day: string,
  fileState: LuckFileStateHolder,
  pending: LuckPendingEntry[]
): Promise<void> {
  mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
  if (fileState.current?.day !== day) {
    fileState.current = await openDayFile(LUCK_MEMORY_DIR, day, PERSISTED_FILE_MODE);
  }
  const chunk: string = pending.map((entry: LuckPendingEntry): string => serializeDayFileEntry(entry.key, entry.record)).join(",\n");
  await appendToDayFile({
    dir: LUCK_MEMORY_DIR,
    state: fileState.current,
    chunk,
    mode: PERSISTED_FILE_MODE,
  });
}
