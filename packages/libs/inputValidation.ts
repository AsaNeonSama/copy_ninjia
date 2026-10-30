import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isErrno } from "./errno";

/**
 * 不可信部署输入的安全错误。消息只包含来源、字段路径和期望形态，不携带
 * 实际值或底层异常。
 */
export class InputValidationError extends Error {
  constructor(sourcePath: string, fieldPath: string, expected: string) {
    super(`${sourcePath}: ${fieldPath} must be ${expected}.`);
    this.name = "InputValidationError";
  }
}

/**
 * 抛出统一的安全输入错误；返回 never 便于解码分支直接收窄类型。
 * @param sourcePath 输入文件或数据来源标识。
 * @param fieldPath 校验失败的字段路径。
 * @param expected 字段期望形态的英文描述。
 */
export function invalidInput(
  sourcePath: string,
  fieldPath: string,
  expected: string
): never {
  throw new InputValidationError(sourcePath, fieldPath, expected);
}

/** 解码字段所在的输入来源与对象路径；原语报错时拼成 `<path>.<key>`。 */
export interface InputFieldContext {
  /** 输入文件或数据来源路径。 */
  readonly source: string;
  /** 当前对象在根文档中的字段路径。 */
  readonly path: string;
}

/**
 * 解码必填非空字符串：返回去掉首尾空白后的值；不是字符串或去掉后为空即拒绝。
 * @param value 待校验的原始字段值。
 * @param fieldPath 字段在文档中的路径。
 * @param sourcePath 输入文件或数据来源路径。
 * @returns 去掉首尾空白后的非空字符串。
 */
export function requiredString(value: unknown, fieldPath: string, sourcePath: string): string {
  const text: string = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return invalidInput(sourcePath, fieldPath, "a non-empty string");
  return text;
}

/**
 * 读取对象上的可选布尔字段：缺省为 undefined，存在但不是布尔即拒绝。
 * @param value 包含目标字段的只读记录对象。
 * @param key 待读取的属性键名。
 * @param context 输入来源与父对象字段路径上下文。
 * @returns 布尔字段值；字段缺省时返回 undefined。
 */
export function optionalBooleanField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  { source, path }: InputFieldContext
): boolean | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") return invalidInput(source, `${path}.${key}`, "a boolean");
  return field;
}

/**
 * 读取对象上的可选字符串字段：缺省为 undefined，存在但不是字符串即拒绝；字符串原样返回，
 * 空字符串与首尾空白均保留。
 * @param value 包含目标字段的只读记录对象。
 * @param key 待读取的属性键名。
 * @param context 输入来源与父对象字段路径上下文。
 * @returns 原样保留的字符串字段值；字段缺省时返回 undefined。
 */
export function optionalStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  { source, path }: InputFieldContext
): string | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") return invalidInput(source, `${path}.${key}`, "a string");
  return field;
}

/**
 * 读取对象上的可选毫秒时间戳：缺省为 undefined，存在时必须是非负安全整数。
 * @param value 包含目标字段的只读记录对象。
 * @param key 待读取的属性键名。
 * @param context 输入来源与父对象字段路径上下文。
 * @returns 非负安全整数毫秒时间戳；字段缺省时返回 undefined。
 */
export function optionalTimestampField(
  value: Readonly<Record<string, unknown>>,
  key: string,
  { source, path }: InputFieldContext
): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    return invalidInput(source, `${path}.${key}`, "a non-negative safe integer timestamp");
  }
  return field;
}

const STRICT_UTF8_DECODER: TextDecoder = new TextDecoder("utf-8", {
  fatal: true,
});

/**
 * Bun 原生读取部署/持久化内容，并拒绝普通 Blob.text 会替换掉的非法 UTF-8。
 * @param sourcePath 待读取的文件路径。
 * @returns 严格按 UTF-8 解码后的完整文本内容。
 */
export async function readUtf8TextInput(sourcePath: string): Promise<string> {
  const bytes: Uint8Array = await Bun.file(sourcePath).bytes();
  return STRICT_UTF8_DECODER.decode(bytes);
}

/**
 * 叶子路径本身是否不存在，以 `lstat` 报 ENOENT 为准（`BunFile.stat()` 跟随软链接，
 * 悬空链接同样报 ENOENT）。
 *
 * @param path 待检查的文件系统路径。
 * @returns 叶子路径本身不存在时返回 `true`。
 */
export async function isMissingLeaf(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    return isErrno(error, "ENOENT");
  }
}

/**
 * 可选持久化状态文件的严格读取边界：叶子路径本身必须是普通文件，内容必须是严格 UTF-8。
 *
 * 类型经 `lstat` 判定，不跟随软链接：软链接（含指向普通文件的链接与悬空链接）、目录、其它非普通文件以及
 * EACCES/ELOOP/ENOTDIR 等访问失败一律是已配置但非法，按 AGENTS.md 的「不为用户行为兜底」拒绝启动；
 * 只有 `lstat` 报 ENOENT 才按缺失处理。lstat 成功之后的读取或解码失败也不降级为缺失。
 *
 * 错误统一收敛为 InputValidationError，只带文件路径、字段路径和期望形态，不回显
 * 底层异常与状态内容（见 docs/cn/04-invariants.md 的严格解析约束）。
 *
 * @param path 状态文件路径。
 * @returns 文件文本；叶子路径真正缺失时为 null。
 */
export async function readOptionalRegularTextInput(path: string): Promise<string | null> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    return invalidInput(path, "$", "an accessible regular file");
  }
  if (!stats.isFile()) return invalidInput(path, "$", "a regular file, not a symbolic link");
  try {
    return await readUtf8TextInput(path);
  } catch {
    return invalidInput(path, "$", "a regular file readable as strictly valid UTF-8 text");
  }
}

/**
 * 读取并解析一份 JSON 部署输入。读取失败与语法错误都收敛为安全诊断，不把
 * 操作系统路径细节、原始 JSON 片段或解析异常回显到日志。
 * @param sourcePath 待读取并解析的 JSON 文件路径。
 * @returns JSON.parse 解析得到的未知值。
 */
export async function readJsonInput(sourcePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readUtf8TextInput(sourcePath)) as unknown;
  } catch {
    return invalidInput(sourcePath, "$", "a readable valid JSON document");
  }
}

/**
 * 解析已经读入的 JSON 状态文本；语法错误不得携带原文片段逸出。
 * @param content 已读入内存的 JSON 文本。
 * @param sourcePath 输入来源标识，用于构造安全诊断错误。
 * @returns JSON.parse 解析得到的未知值。
 */
export function parseJsonInput(content: string, sourcePath: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return invalidInput(sourcePath, "$", "valid JSON");
  }
}
