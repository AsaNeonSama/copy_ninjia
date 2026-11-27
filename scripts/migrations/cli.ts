import { invalidInput } from "../../packages/libs/inputValidation";

/** 冷迁移 CLI 解析出的停机备份源目录与新建产物目录。 */
export interface SourceOutputRoots {
  /** `--source-root` 指定的停机备份根目录路径。 */
  readonly sourceRoot: string;
  /** `--output-root` 指定的独立迁移产物目录路径。 */
  readonly outputRoot: string;
}

/** 冷迁移 CLI 解析出的停机备份数据根、可选配置根与新建产物目录。 */
export interface SourceConfigOutputRoots extends SourceOutputRoots {
  /** 显式 `--config-root` 指定的停机备份配置目录；未传入时为 undefined（缺省按 `<sourceRoot>/config` 解析）。 */
  readonly configRoot?: string;
}

/**
 * 按 `<option> <value>` 成对解析冷迁移路径参数并去掉首尾空白；未知选项、重复选项、缺值、空白值或去空白后以 `--` 开头的值一律拒绝。
 * @param args 命令行参数列表。
 * @param allowedKeys 允许出现的选项名白名单。
 * @param usage 选项形态不合法时回显的期望用法说明。
 * @returns 选项名到已去首尾空白路径值的只读映射。
 */
function parseRootArguments(
  args: readonly string[],
  allowedKeys: readonly string[],
  usage: string
): ReadonlyMap<string, string> {
  const values: Map<string, string> = new Map<string, string>();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    const trimmed: string = value === undefined ? "" : value.trim();
    if (
      key === undefined ||
      !allowedKeys.includes(key) ||
      values.has(key) ||
      trimmed.length === 0 ||
      trimmed.startsWith("--")
    ) {
      return invalidInput("arguments", "$", usage);
    }
    values.set(key, trimmed);
  }
  return values;
}

/**
 * 解析 `--source-root <cold-backup> --output-root <new-directory>`，不默认选取部署路径。
 * 未知选项、重复选项、缺值、空白值或去空白后以 `--` 开头的值一律拒绝；值去掉首尾空白。
 * @param args 命令行参数列表。
 * @returns 解析出的停机备份根与独立产物目录。
 */
export function parseSourceOutputRoots(args: readonly string[]): SourceOutputRoots {
  const values: ReadonlyMap<string, string> = parseRootArguments(
    args,
    ["--source-root", "--output-root"],
    "--source-root <cold-backup> --output-root <new-directory>"
  );
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) {
    return invalidInput("arguments", "$", "both required path options");
  }
  return { sourceRoot, outputRoot };
}

/**
 * 解析 `--source-root <cold-backup> [--config-root <config-backup>] --output-root <new-directory>`，不默认选取部署路径。
 * 未知选项、重复选项、缺值、空白值或去空白后以 `--` 开头的值一律拒绝；值去掉首尾空白。
 * @param args 命令行参数列表。
 * @returns 解析出的停机备份数据根、可选配置根与独立产物目录。
 */
export function parseSourceConfigOutputRoots(args: readonly string[]): SourceConfigOutputRoots {
  const values: ReadonlyMap<string, string> = parseRootArguments(
    args,
    ["--source-root", "--config-root", "--output-root"],
    "--source-root <cold-backup> [--config-root <config-backup>] --output-root <new-directory>"
  );
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) {
    return invalidInput("arguments", "$", "both required path options");
  }
  const configRoot: string | undefined = values.get("--config-root");
  return configRoot === undefined
    ? { sourceRoot, outputRoot }
    : { sourceRoot, configRoot, outputRoot };
}
