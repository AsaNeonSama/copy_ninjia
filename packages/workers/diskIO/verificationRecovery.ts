/** 待验证日文件的恢复、跨日合并与 compact（所属线程：Disk I/O Worker）。 */

import { inspectOptionalFile, inspectOptionalDirectory } from "../../libs/fileAccess";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { DAY_FILE_JSON_INDENT, DAY_FILE_PATTERN } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import {
  VERIFICATION_CORRUPT_DAY_FILE_SUFFIX,
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_COMPACT_ENTRIES,
  VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS,
  VERIFICATION_TOP_LEVEL_ENTRY_PATTERN,
} from "../../consts/diskIO/verification";
import { VERIFICATION_MEMORY_DIR } from "../../consts/paths";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationPriorDayDecodeFailures,
  verificationWorkerCache,
} from "../../cache/workers/diskIO/verification";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { InputValidationError, invalidInput, readUtf8TextInput } from "../../libs/inputValidation";
import { getDateKey, isCanonicalDateKey } from "../../libs/time";
import type { VerificationSnapshot } from
  "../../types/antiRaid/verification";
import { VERIFICATION_RECORD_CAPACITY } from "../../consts/antiRaid/verification";
import { openValidatedAppendOnlyFile } from "./appendOnlyDayFile";
import {
  decodeVerificationDay,
  storedVerificationSnapshot,
} from "./verificationCodec";
import type { VerificationDayValue } from "./verificationCodec";

/** 待验证目录扫描得出的旧日恢复与清理计划。 */
interface VerificationDirectoryRecoveryPlan {
  /** 早于今日的最新旧日日期键（`YYYY-MM-DD`）；无旧日文件时为 `undefined`。 */
  readonly latestPriorDay: string | undefined;
  /** 早于今日的全部旧日文件名列表（含 `latestPriorDay`）。 */
  readonly oldDayNames: string[];
  /** 晚于今日的未来日期文件数量。 */
  readonly futureDayCount: number;
}

/** 待验证日文件启动只读探测的快照结果。 */
export interface VerificationRecoveryInspection {
  /** 当前目标日期键（`YYYY-MM-DD`）。 */
  readonly day: string;
  /** 待验证目录绝对路径。 */
  readonly dir: string;
  /** 从旧日与当日文件合并恢复出的活跃待验证快照映射。 */
  readonly recovered: Map<string, VerificationSnapshot>;
  /** 当日文件的初始追加游标状态。 */
  readonly fileState: {
    /** 当日日期键（`YYYY-MM-DD`）。 */
    readonly day: string;
    /** 当日文件当前字节大小。 */
    readonly size: number;
    /** 当日文件是否为空对象 `{}`。 */
    readonly empty: boolean;
  };
  /** 当日文件已累积的顶层追加条目数。 */
  readonly appendedEntries: number;
  /** 当日文件已累积的字节数。 */
  readonly appendedBytes: number;
  /** 目录扫描得出的旧日合并与清理计划。 */
  readonly directoryPlan: VerificationDirectoryRecoveryPlan;
  /** 恢复完成后是否需要立即原子重写并 compact 当日文件。 */
  readonly shouldCompact: boolean;
}

/**
 * 校验目录内 JSON 文件名，提取最新旧日与待清理旧日列表。
 * @param day 当前配置时区的 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径。
 * @param entries 目录下的 `Dirent` 条目列表。
 * @returns 包含最新旧日、待删除旧日文件名列表与未来日文件计数的恢复计划。
 */
function inspectVerificationDirectory(
  day: string,
  dir: string,
  entries: readonly Dirent<string>[]
): VerificationDirectoryRecoveryPlan {
  let latestPriorDay: string | undefined;
  const oldDayNames: string[] = [];
  let futureDayCount: number = 0;
  for (const entry of entries) {
    const name: string = entry.name;
    if (!name.endsWith(".json")) continue;
    const path: string = join(dir, name);
    if (!entry.isFile()) return invalidInput(path, "$type", "a regular file without symbolic-link indirection");
    const candidate: string | undefined = DAY_FILE_PATTERN.exec(name)?.[1];
    if (candidate === undefined) {
      return invalidInput(path, "$filename", "the canonical <YYYY-MM-DD>.json form");
    }
    if (!isCanonicalDateKey(candidate)) {
      return invalidInput(path, "$filename", "a canonical calendar date");
    }
    if (candidate === day) continue;
    if (candidate > day) {
      futureDayCount++;
      continue;
    }
    oldDayNames.push(name);
    if (latestPriorDay === undefined || candidate > latestPriorDay) {
      latestPriorDay = candidate;
    }
  }
  return { latestPriorDay, oldDayNames, futureDayCount };
}

/**
 * 校验恢复出的 active 待验证记录总数不超过 `VERIFICATION_RECORD_CAPACITY`。
 * @param records 合并后的 active 待验证快照映射。
 * @param sourcePath 用于构造错误消息的来源文件路径。
 */
function assertRecoveredVerificationCapacity(
  records: ReadonlyMap<string, VerificationSnapshot>,
  sourcePath: string
): void {
  if (records.size <= VERIFICATION_RECORD_CAPACITY) return;
  return invalidInput(
    sourcePath,
    "$",
    `a JSON object with at most ${VERIFICATION_RECORD_CAPACITY} active verification records`
  );
}

/**
 * 按日期由旧到新删除严格早于 day 的待验证日文件，保留晚于 day 的文件。
 * @param day 当前基准 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。
 */
export async function removeOldVerificationDays(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  await applyVerificationDirectoryRecoveryPlan(day, dir, scanVerificationDayFiles(day, dir));
}

/**
 * 扫描目录中的日期命名普通文件，按 day 划分旧日列表、最新旧日与晚于 day 的文件数。
 * @param day 当前基准 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径。
 * @returns 目录中旧日文件与未来日文件的分类计划。
 */
function scanVerificationDayFiles(day: string, dir: string): VerificationDirectoryRecoveryPlan {
  let latestPriorDay: string | undefined;
  const oldDayNames: string[] = [];
  let futureDayCount: number = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const candidate: string | undefined = DAY_FILE_PATTERN.exec(entry.name)?.[1];
    if (candidate === undefined || candidate === day) continue;
    if (candidate > day) {
      futureDayCount++;
      continue;
    }
    oldDayNames.push(entry.name);
    if (latestPriorDay === undefined || candidate > latestPriorDay) latestPriorDay = candidate;
  }
  return { latestPriorDay, oldDayNames, futureDayCount };
}

/**
 * 按计划从旧到新删除早于 day 的日文件；存在晚于 day 的文件时输出告警并保留。
 * @param day 当前基准 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径。
 * @param plan 包含待删除旧日文件名列表与未来日文件计数的计划。
 */
async function applyVerificationDirectoryRecoveryPlan(
  day: string,
  dir: string,
  plan: Pick<VerificationDirectoryRecoveryPlan, "oldDayNames" | "futureDayCount">
): Promise<void> {
  if (plan.futureDayCount > 0) {
    console.error(
      `[diskIOWorker] kept ${plan.futureDayCount} verification day file(s) dated after ${day}: ` +
      "the host clock most likely stepped backwards, and these files hold pending " +
      "verifications that this recovery refuses to merge."
    );
  }
  const oldDayNames: string[] = [...plan.oldDayNames].sort();
  for (const name of oldDayNames) await Bun.file(join(dir, name)).delete();
}

/**
 * 读取并解码旧日文件；编码或格式错误连续达 VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS 时
 * 追加 VERIFICATION_CORRUPT_DAY_FILE_SUFFIX 隔离并返回 null。
 * @param priorPath 旧日待验证文件的绝对路径。
 * @returns 解码后的记录映射；达到连续失败上限并隔离文件后返回 null。
 */
async function decodePriorDayOrQuarantine(priorPath: string): Promise<Map<string, VerificationDayValue> | null> {
  let values: Map<string, VerificationDayValue>;
  try {
    values = decodeVerificationDay(priorPath, await readUtf8TextInput(priorPath));
  } catch (error: unknown) {
    if (!(error instanceof InputValidationError) && !(error instanceof TypeError)) throw error;
    const failures: { path: string | null; count: number } = verificationPriorDayDecodeFailures;
    failures.count = failures.path === priorPath ? failures.count + 1 : 1;
    failures.path = priorPath;
    if (failures.count < VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS) throw error;
    failures.path = null;
    failures.count = 0;
    const corruptPath: string = `${priorPath}${VERIFICATION_CORRUPT_DAY_FILE_SUFFIX}`;
    renameSync(priorPath, corruptPath);
    console.error(
      `[diskIOWorker] verification day file ${priorPath} failed to decode ` +
      `${VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS} times in a row; renamed it to ${corruptPath} ` +
      "and the new day continues from the in-memory verification mirror:",
      error
    );
    return null;
  }
  verificationPriorDayDecodeFailures.path = null;
  verificationPriorDayDecodeFailures.count = 0;
  return values;
}

/**
 * 提取早于 day 的最新可用旧日文件中仍为 active 但当前内存镜像已删除的键列表。
 * @param day 当前基准 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径。
 * @returns 需要在新日文件中写入 null 墓碑以遮蔽旧日 active 记录的键列表。
 */
async function priorDayTombstoneKeys(day: string, dir: string): Promise<string[]> {
  for (;;) {
    const latestPriorDay: string | undefined = scanVerificationDayFiles(day, dir).latestPriorDay;
    if (latestPriorDay === undefined) return [];
    const values: Map<string, VerificationDayValue> | null =
      await decodePriorDayOrQuarantine(join(dir, `${latestPriorDay}.json`));
    if (values === null) continue;
    const keys: string[] = [];
    for (const [key, value] of values) {
      if (value !== null && !verificationWorkerCache.has(key)) keys.push(key);
    }
    return keys;
  }
}

/**
 * 将当前 active 镜像及覆盖旧日所需的 null 墓碑原子重写为指定日期文件。
 * @param day 目标 `YYYY-MM-DD` 日期键。
 * @param dir 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。
 */
export async function compactVerificationDay(
  day: string,
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const compacted: Record<string, unknown> = {};
  for (const [key, snapshot] of verificationWorkerCache) {
    compacted[key] = storedVerificationSnapshot(snapshot);
  }
  const tombstoneKeys: string[] = await priorDayTombstoneKeys(day, dir);
  for (const key of tombstoneKeys) compacted[key] = null;
  const content: string = JSON.stringify(compacted, null, DAY_FILE_JSON_INDENT);
  atomicWriteTextSync(join(dir, `${day}.json`), content, PERSISTED_FILE_MODE);
  const empty: boolean = verificationWorkerCache.size === 0 && tombstoneKeys.length === 0;
  verificationFileState.current = {
    day,
    size: empty ? 0 : Buffer.byteLength(content),
    empty,
  };
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
}

/**
 * 启动第一阶段：只读校验配置时区的当天及最新旧日，构造接管与维护计划。
 * @param day 当前配置时区的 `YYYY-MM-DD` 日期键；缺省为当前时刻。
 * @param dir 待验证目录路径；缺省为 `VERIFICATION_MEMORY_DIR`。
 * @returns 包含恢复快照、文件游标、追加统计与目录清理计划的只读探测结果。
 */
export async function inspectVerificationDay(
  day: string = getDateKey(),
  dir: string = VERIFICATION_MEMORY_DIR
): Promise<VerificationRecoveryInspection> {
  const entries: readonly Dirent<string>[] = inspectOptionalDirectory(dir)
    ? readdirSync(dir, { withFileTypes: true })
    : [];
  const directoryPlan: VerificationDirectoryRecoveryPlan = inspectVerificationDirectory(
    day,
    dir,
    entries
  );

  const path: string = join(dir, `${day}.json`);
  const priorDay: string | undefined = directoryPlan.latestPriorDay;
  const recovered: Map<string, VerificationSnapshot> = new Map();
  let currentContent: string | null = null;
  let decodedEntryCount: number = 0;
  const currentFileExists: boolean = inspectOptionalFile(path);
  if (priorDay !== undefined) {
    const priorPath: string = join(dir, `${priorDay}.json`);
    const priorValues: Map<string, VerificationDayValue> =
      decodeVerificationDay(priorPath, await readUtf8TextInput(priorPath));
    for (const [key, value] of priorValues) {
      if (value !== null) recovered.set(key, value);
    }

    if (currentFileExists) {
      currentContent = await readUtf8TextInput(path);
      const currentValues: Map<string, VerificationDayValue> =
        decodeVerificationDay(path, currentContent);
      decodedEntryCount = currentValues.size;
      for (const [key, value] of currentValues) {
        if (value === null) recovered.delete(key);
        else recovered.set(key, value);
      }
    }

    assertRecoveredVerificationCapacity(
      recovered,
      currentFileExists ? path : priorPath
    );
  } else if (currentFileExists) {
    currentContent = await readUtf8TextInput(path);
    const decoded: Map<string, VerificationDayValue> =
      decodeVerificationDay(path, currentContent);
    decodedEntryCount = decoded.size;
    for (const [key, value] of decoded) {
      if (value !== null) recovered.set(key, value);
    }
    assertRecoveredVerificationCapacity(recovered, path);
  }

  const fileState: VerificationRecoveryInspection["fileState"] = currentContent === null
    ? { day, size: 0, empty: true }
    : {
      day,
      ...openValidatedAppendOnlyFile({
        path,
        content: currentContent,
        empty: decodedEntryCount === 0,
      }),
    };
  const appendedEntries: number = currentContent?.match(
    VERIFICATION_TOP_LEVEL_ENTRY_PATTERN
  )?.length ?? 0;
  return {
    day,
    dir,
    recovered,
    fileState,
    appendedEntries,
    appendedBytes: fileState.size,
    directoryPlan,
    shouldCompact: priorDay !== undefined ||
      appendedEntries >= VERIFICATION_FILE_COMPACT_ENTRIES ||
      fileState.size >= VERIFICATION_FILE_COMPACT_BYTES,
  };
}

/**
 * 全域 inspect 成功后整体发布 verification owner 与追加游标。
 * @param inspection 启动只读扫描阶段产出的待验证探测结果。
 * @returns 已填充完成的待验证内存镜像映射。
 */
export function adoptVerificationDay(
  inspection: VerificationRecoveryInspection
): Map<string, VerificationSnapshot> {
  resetVerificationPersistenceCache();
  for (const [key, snapshot] of inspection.recovered) {
    verificationWorkerCache.set(key, snapshot);
  }
  verificationFileState.current = inspection.fileState;
  verificationFileState.appendedEntries = inspection.appendedEntries;
  verificationFileState.appendedBytes = inspection.appendedBytes;
  return verificationWorkerCache;
}

/**
 * 启动成功后执行 compact 与旧日清理；compact 失败时不删除恢复基线。
 * @param inspection 启动只读扫描阶段产出的待验证探测结果。
 */
export async function maintainVerificationDay(
  inspection: VerificationRecoveryInspection
): Promise<void> {
  try {
    mkdirSync(inspection.dir, { recursive: true });
    if (inspection.shouldCompact) {
      await compactVerificationDay(inspection.day, inspection.dir);
    }
    await applyVerificationDirectoryRecoveryPlan(
      inspection.day,
      inspection.dir,
      inspection.directoryPlan
    );
  } catch (error: unknown) {
    verificationFileState.current = null;
    verificationFileState.appendedEntries = 0;
    verificationFileState.appendedBytes = 0;
    throw error;
  }
}
