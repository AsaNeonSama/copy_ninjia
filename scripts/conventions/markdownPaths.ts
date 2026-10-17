import { dirname, relative } from "node:path";
import { withoutMarkdownCodeFences } from "./markdownSource";

/**
 * 文档里反引号包裹的仓库路径存在性核对。
 *
 * 判存以受跟踪文件集合（含未忽略的新文件，过滤掉尚未 stage 的已删除文件）及其全部祖先目录为准；
 * 只在本机工作树存在、被 Git 忽略的路径同样报缺失。
 */

/** 行内反引号片段。 */
const INLINE_CODE_PATTERN: RegExp = /`([^`\n]+)`/g;

/**
 * 受核对的仓库顶层前缀与纯路径形态；含 `<`、`*`、`{`、空格、`:`、`#` 的片段自然不命中，
 * 含 `xxx` 占位名的片段（如 `test/commands/xxx.test.ts`）由调用处跳过。
 */
const REPOSITORY_PATH_PATTERN: RegExp =
  /^(?:packages|scripts|test|docs|config_example|prompt_example|public|LICENSES)(?:\/[A-Za-z0-9_.-]+)*\/?$/;

/** 由现存受跟踪文件列表构建包含文件自身与全部祖先目录的仓库路径集合。 */
export function collectRepositoryPaths(
  files: readonly string[]
): ReadonlySet<string> {
  const paths: Set<string> = new Set<string>();
  for (const file of files) {
    paths.add(file);
    let directory: string = dirname(file);
    while (directory !== "." && directory !== "/") {
      paths.add(directory);
      directory = dirname(directory);
    }
  }
  return paths;
}

/** 核对一份 Markdown 里反引号包裹的仓库文件与目录路径是否仍在受跟踪集合中。 */
export async function collectMarkdownPathProblems(
  projectRoot: string,
  path: string,
  repositoryPaths: ReadonlySet<string>
): Promise<readonly string[]> {
  const problems: string[] = [];
  const source: string = withoutMarkdownCodeFences(await Bun.file(path).text());
  for (const match of source.matchAll(INLINE_CODE_PATTERN)) {
    const candidate: string | undefined = match[1];
    if (candidate === undefined) continue;
    if (!REPOSITORY_PATH_PATTERN.test(candidate)) continue;
    if (candidate.includes("xxx")) continue;
    const normalized: string = candidate.endsWith("/")
      ? candidate.slice(0, -1)
      : candidate;
    if (repositoryPaths.has(normalized)) continue;
    const line: number = source.slice(0, match.index).split("\n").length;
    problems.push(
      `${relative(projectRoot, path)}:${line} references a missing repository path: ${candidate}`
    );
  }
  return problems;
}
