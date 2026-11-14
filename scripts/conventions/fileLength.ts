/** 手写源码的文件长度硬上限；超过后必须按职责拆分。 */
export const MAX_SOURCE_LINES: number = 1_024;

/** Mini App 前端 `.tsx`、`.css` 与 `.html` 手写源码的文件长度硬上限；超过后必须按职责拆分。 */
export const MAX_FRONTEND_SOURCE_LINES: number = 1_536;

/**
 * 受文件长度硬门禁约束的手写源码后缀（TS、JS、CSS、HTML、shell）。不带 g/y 标志，test() 可重复共享；
 * 本文件的 collectFileLengthProblems 与 `scripts/checkProjectConventions.ts` 的读文件前置判定共用。
 */
export const FILE_LENGTH_CHECKED_PATH_PATTERN: RegExp = /\.(?:[cm]?[jt]sx?|css|html|sh)$/;

/**
 * 检查 TS、JS、CSS、HTML 和 shell 源码的物理行数；末尾换行不额外计作空行。
 *
 * @param path 相对仓库根的源码文件路径
 * @param source 文件文本内容
 * @returns 超出上限时的违规信息列表
 */
export function collectFileLengthProblems(path: string, source: string): readonly string[] {
  if (!FILE_LENGTH_CHECKED_PATH_PATTERN.test(path)) return [];
  const maxLines: number =
    path.endsWith(".html") ||
    (path.startsWith("packages/mini-app-frontend/") && /\.(?:tsx|css)$/.test(path))
      ? MAX_FRONTEND_SOURCE_LINES
      : MAX_SOURCE_LINES;
  const lines: number = source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return lines > maxLines
    ? [`${path} has ${lines} lines; split source files exceeding ${maxLines} lines`]
    : [];
}
