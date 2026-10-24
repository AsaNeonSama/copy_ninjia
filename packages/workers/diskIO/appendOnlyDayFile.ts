/**
 * 顶层 JSON 对象文件的按位置追加、只读探测与尾部截断修复。
 */

import { closeSync, fsyncSync, ftruncateSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppendOnlyFileState, DayFileState } from "../../types/diskIO/storage";
import { DAY_FILE_ENTRY_INDENT, DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { atomicWriteTextSync, writeBufferFullySync } from "../../libs/atomicFile";
import type { SyncBufferWriter } from "../../libs/atomicFile";
import { readUtf8TextInput } from "../../libs/inputValidation";
import { isPlainRecord } from "../../libs/record";
import { inspectOptionalFile } from "../../libs/fileAccess";
import { toErrorOr } from "../../libs/errorMessage";

const UTF8_ENCODER: TextEncoder = new TextEncoder();
/** 追加型 JSON 对象文件结尾的闭合字节序列。 */
const APPEND_ONLY_TAIL: Uint8Array = UTF8_ENCODER.encode("\n}");

if (DAY_FILE_JSON_INDENT < 1) {
  throw new Error("DAY_FILE_JSON_INDENT must be >= 1: serializeDayFileEntry relies on multi-line JSON.stringify output");
}

export type SyncFile = (fd: number) => void;

export interface OpenValidatedAppendOnlyFileOptions {
  /** 已由领域 codec 严格校验过的目标路径。 */
  readonly path: string;
  /** 与领域校验使用同一轮读取取得的原始文本。 */
  readonly content: string;
  /** 顶层对象是否为空对象。 */
  readonly empty: boolean;
}

/** 目标文件不是可安全追记的当前格式。 */
export class AppendOnlyFileFormatError extends Error {
  constructor(path: string, reason: string) {
    super(`${path} ${reason}`);
    this.name = "AppendOnlyFileFormatError";
  }
}

/**
 * 打开或接管一个追加型 JSON 对象文件并返回追加游标。
 * @param path 目标追加型 JSON 文件路径。
 * @param mode 原子重写文件时使用的 POSIX 权限位。
 * @param repair 为 true 时允许裁掉撕裂尾部并原子重写规范排版；为 false 时遇到损坏或非规范结尾直接抛错。
 * @returns 目标文件的物理大小与空对象状态游标。
 */
export async function openAppendOnlyFile(
  path: string,
  mode?: number,
  repair: boolean = false
): Promise<AppendOnlyFileState> {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!inspectOptionalFile(path)) return state;
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    if (!repair) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed; refusing to repair this file.");
    }
    const repaired: string | null = repairTruncatedAppendOnlyContent(content);
    if (repaired === null) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed or repaired.");
    }
    const repairedParsed: unknown = JSON.parse(repaired);
    if (!isPlainRecord(repairedParsed)) {
      throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
    }
    atomicWriteTextSync(path, repaired, mode);
    state.size = statSync(path).size;
    state.empty = Object.keys(repairedParsed).length === 0;
    return state;
  }
  if (!isPlainRecord(parsed)) {
    throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
  }
  if (Object.keys(parsed).length === 0) return state;
  if (!content.endsWith("\n}")) {
    if (!repair) {
      throw new AppendOnlyFileFormatError(
        path,
        "must use the canonical append-only JSON object formatting."
      );
    }
    atomicWriteTextSync(path, JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT), mode);
  }
  state.size = statSync(path).size;
  state.empty = false;
  return state;
}

/** inspectRepairableAppendOnlyFile 的只读探测结果。 */
export interface RepairableAppendOnlyInspection<T> {
  /** 领域解码器返回的结果。 */
  readonly decoded: T;
  /** 需要原子发布的修复或规范排版文本；无需重写时为 null。 */
  readonly rewriteContent: string | null;
  /** 发布后可追加的游标。 */
  readonly state: AppendOnlyFileState;
}

/**
 * 只读探测允许自愈的追加型 JSON 对象文件：内存中修复截断尾部、执行领域解码并计算追加游标；文件不存在时返回 null。
 * @param path 目标追加型 JSON 文件路径。
 * @param decode 校验并转换 JSON.parse 结果的领域解码器。
 * @returns 包含解码结果、待重写文本与游标的探测结果；文件不存在时返回 null。
 */
export async function inspectRepairableAppendOnlyFile<T>(
  path: string,
  decode: (parsed: unknown) => T
): Promise<RepairableAppendOnlyInspection<T> | null> {
  if (!inspectOptionalFile(path)) return null;
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  let rewriteContent: string | null = null;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    rewriteContent = repairTruncatedAppendOnlyContent(content);
    if (rewriteContent === null) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed or repaired.");
    }
    parsed = JSON.parse(rewriteContent) as unknown;
  }
  const decoded: T = decode(parsed);
  const empty: boolean = Object.keys(parsed as Record<string, unknown>).length === 0;
  if (!empty && rewriteContent === null && !content.endsWith("\n}")) {
    rewriteContent = JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT);
  }
  return {
    decoded,
    rewriteContent,
    state: {
      size: empty
        ? 0
        : rewriteContent === null
          ? (await Bun.file(path).stat()).size
          : Buffer.byteLength(rewriteContent),
      empty,
    },
  };
}

/**
 * 接管已由领域解码器校验过的追加型文件，复核规范结尾并返回物理大小游标。
 * @param options 已校验文件的路径、原始文本与空对象标记。
 * @returns 目标文件的物理大小与空对象状态游标。
 */
export function openValidatedAppendOnlyFile({
  path,
  content,
  empty,
}: OpenValidatedAppendOnlyFileOptions): AppendOnlyFileState {
  const state: AppendOnlyFileState = { size: 0, empty: true };
  if (!inspectOptionalFile(path)) return state;
  if (empty) return state;
  if (!content.endsWith("\n}")) {
    throw new AppendOnlyFileFormatError(
      path,
      "must use the canonical append-only JSON object formatting."
    );
  }
  state.size = statSync(path).size;
  state.empty = false;
  return state;
}

/**
 * 打开 `<dir>/<day>.json` 追加型日文件并返回带日期键的游标。
 * @param dir 日文件所在目录路径。
 * @param day `YYYY-MM-DD` 日期键。
 * @param mode 原子重写文件时使用的 POSIX 权限位。
 * @returns 绑定日期键的文件追加游标。
 */
export async function openDayFile(
  dir: string,
  day: string,
  mode?: number
): Promise<DayFileState> {
  return { day, ...await openAppendOnlyFile(join(dir, `${day}.json`), mode) };
}

/**
 * 构造并验证指定顶层成员逗号边界处的截断修复候选文本。
 * @param content 原始被截断的文件文本。
 * @param boundaries 顶层成员间逗号的字符偏移列表。
 * @param boundaryIndex 待尝试的逗号边界下标。
 * @returns 可成功解析为 JSON 的修复后文本；解析失败时返回 null。
 */
function repairCandidateAt(
  content: string,
  boundaries: readonly number[],
  boundaryIndex: number
): string | null {
  const candidate: string = `${content.slice(0, boundaries[boundaryIndex])}\n}`;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * 修复被截断的追加型 JSON 对象文本：先尝试直接补齐闭合花括号，失败时扫描顶层成员逗号边界并二分查找最长可解析前缀。
 * @see ../../../docs/cn/04-invariants.md
 * @param content 原始损坏或尾部截断的 JSON 文本。
 * @returns 恢复出的最长合法 JSON 对象文本；无法修复时返回 null。
 */
export function repairTruncatedAppendOnlyContent(content: string): string | null {
  const withClosingBrace: string = `${content}\n}`;
  try {
    JSON.parse(withClosingBrace);
    return withClosingBrace;
  } catch {
    // 继续尝试裁掉末尾残片。
  }
  const boundaries: number[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let escaped: boolean = false;
  for (let i: number = 0; i < content.length; i++) {
    const char: string = content[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
    } else if (char === "," && depth === 1) {
      boundaries.push(i);
    }
  }

  if (boundaries.length === 0) return null;
  // 尾部撕裂是常见情况，先只试最后一个完整成员边界。
  const last: string | null = repairCandidateAt(content, boundaries, boundaries.length - 1);
  if (last !== null) return last;

  // 顶层边界候选具有「前缀有效、后缀无效」的单调性：某个边界之前一旦已有
  // 非法 token，之后追加完整的 `, member` 不会改正更早的语法；损坏发生前的
  // 所有完整成员前缀都可独立补 `}` 解析。因此对最后一个有效前缀二分。
  let low: number = 0;
  let high: number = boundaries.length - 2;
  let best: string | null = null;
  while (low <= high) {
    const middle: number = low + Math.floor((high - low) / 2);
    const candidate: string | null = repairCandidateAt(content, boundaries, middle);
    if (candidate === null) {
      high = middle - 1;
    } else {
      best = candidate;
      low = middle + 1;
    }
  }
  return best;
}

/** 按位置追加写入追加型 JSON 对象文件的参数。 */
export interface AppendToAppendOnlyFileParams {
  /** 目标追加型 JSON 文件路径。 */
  path: string;
  /** 当前文件的大小与空状态游标（成功后原地更新）。 */
  state: AppendOnlyFileState;
  /** 已序列化的一个或多个顶层对象成员片段（不含外层花括号）。 */
  chunk: string;
  /** 首次写入或原子修复时使用的文件权限位。 */
  mode?: number;
  /** 追加失败后重新探测文件时是否允许自愈；语义同 openAppendOnlyFile。 */
  repair?: boolean;
  /** 仅供故障注入测试；生产使用 node:fs writeSync。 */
  write?: SyncBufferWriter;
  /** 仅供故障注入测试；生产在成功回执前 fsync 当前批次。 */
  sync?: SyncFile;
}

/** 按位置追加写入 `<dir>/<state.day>.json` 日文件的参数。 */
export interface AppendToDayFileParams extends Omit<AppendToAppendOnlyFileParams, "path" | "state"> {
  /** 日文件所在目录路径。 */
  dir: string;
  /** 绑定日期键的日文件游标。 */
  state: DayFileState;
}

/**
 * 将已序列化的条目片段追加到文件末尾（空文件走原子写入，非空文件按偏移覆写闭合花括号并 fsync，失败时原位回滚或重探测）。
 * @param params 追加目标路径、游标状态、成员文本片段与可注入 I/O 钩子。
 */
export async function appendToAppendOnlyFile({
  path,
  state,
  chunk,
  mode,
  repair = false,
  write,
  sync = fsyncSync,
}: AppendToAppendOnlyFileParams): Promise<void> {
  if (state.empty) {
    const content: string = `{\n${chunk}\n}`;
    atomicWriteTextSync(path, content, mode);
    state.size = Buffer.byteLength(content);
    state.empty = false;
    return;
  }
  const data: Uint8Array = UTF8_ENCODER.encode(`,\n${chunk}\n}`);
  const fd: number = openSync(path, "r+");
  let failure: unknown = null;
  let restored: boolean = false;
  try {
    writeBufferFullySync(fd, data, { position: state.size - 2, write });
    sync(fd);
  } catch (error: unknown) {
    failure = error;
    restored = restoreAppendTail(fd, state.size, { write, sync });
  }
  try {
    closeSync(fd);
  } catch (error: unknown) {
    failure ??= error;
  }
  if (failure !== null) {
    const appendFailure: Error = toErrorOr(failure, "Append failed with a non-Error value.");
    if (restored) throw appendFailure;
    let recovered: AppendOnlyFileState;
    try {
      recovered = await openAppendOnlyFile(path, mode, repair);
    } catch (error: unknown) {
      throw new AggregateError(
        [appendFailure, error],
        `${path} append failed and could not be restored.`,
        { cause: error }
      );
    }
    state.size = recovered.size;
    state.empty = recovered.empty;
    throw appendFailure;
  }
  state.size = state.size - 2 + data.length;
}

interface RestoreAppendTailOptions {
  /** 可选的同步写入替换钩子。 */
  write: SyncBufferWriter | undefined;
  /** 同步落盘的 fsync 钩子。 */
  sync: SyncFile;
}

/**
 * 将打开的文件描述符截断回追加前大小，原位写回闭合花括号并 fsync。
 * @param fd 已按读写模式打开的目标文件描述符。
 * @param size 追加前的原始文件字节大小。
 * @param options 写入与同步钩子。
 * @returns 原位截断并恢复闭合结尾成功时返回 true，否则返回 false。
 */
function restoreAppendTail(fd: number, size: number, { write, sync }: RestoreAppendTailOptions): boolean {
  try {
    ftruncateSync(fd, size);
    writeBufferFullySync(fd, APPEND_ONLY_TAIL, { position: size - 2, write });
    sync(fd);
    return true;
  } catch (_error: unknown) {
    return false;
  }
}

/**
 * 将已序列化的条目片段追加到 `<dir>/<state.day>.json` 日文件末尾。
 * @param params 日文件目录、带日期键的游标与追加参数。
 */
export async function appendToDayFile({
  dir,
  state,
  ...rest
}: AppendToDayFileParams): Promise<void> {
  await appendToAppendOnlyFile({ path: join(dir, `${state.day}.json`), state, ...rest });
}

/**
 * 将单个键值对序列化为带 `DAY_FILE_JSON_INDENT` 缩进的顶层 JSON 对象成员文本（不含外层花括号与尾随逗号）。
 * @param key 顶层 JSON 对象的属性键。
 * @param value 待序列化的属性值。
 * @returns 缩进对齐后的 `"key": value` 文本片段。
 */
export function serializeDayFileEntry(key: string, value: unknown): string {
  const valueText: string = JSON.stringify([value], null, DAY_FILE_JSON_INDENT);
  return `${DAY_FILE_ENTRY_INDENT}${JSON.stringify(key)}: ${valueText.slice(2 + DAY_FILE_JSON_INDENT, -2)}`;
}
