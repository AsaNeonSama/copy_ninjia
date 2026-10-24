import { existsSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { withoutMarkdownCodeFences } from "./markdownSource";

/**
 * Markdown 本地链接里 `#片段` 的存在性核对。
 *
 * 从目标文档的标题与显式 HTML id 建立锚点集合，核对本地链接的片段。
 */

/**
 * 去掉标题里的行内 Markdown 装饰，只留渲染后的可见文本。
 *
 * @param raw 原始 Markdown 标题文本
 * @returns 剥离行内装饰后的纯文本
 */
function headingText(raw: string): string {
  return raw
    // 行内代码、加粗、斜体与删除线只影响样式，不进锚点。
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/~~([^~]*)~~/g, "$1")
    // 链接只保留可见文字。
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * GitHub 的标题锚点算法：转小写，丢掉除连字符、下划线与空白之外的标点，空白转
 * 连字符；同名标题按出现顺序追加 `-1`、`-2`。emoji 等符号按标点丢弃，因此
 * 「## 🚀 快速开始」得到的是 `-快速开始`。
 *
 * @param source Markdown 文档源码
 * @returns 由 Markdown 标题生成的锚点集合
 */
export function markdownAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  const counts: Map<string, number> = new Map<string, number>();
  for (const match of withoutMarkdownCodeFences(source).matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const slug: string = slugify(headingText(match[2] ?? ""));
    const seen: number = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    anchors.add(seen === 0 ? slug : `${slug}-${seen}`);
  }
  return anchors;
}

/**
 * 把一段文本按 GitHub 的标题锚点规则压成 slug。
 *
 * @param text 标题可见文本
 * @returns 转换后的锚点 slug
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/**
 * HTML 标题（`<h1>`…`<h6>`）同样会生成锚点，取的是去掉内嵌标签后的可见文字。
 * README 的主标题就是这种写法，「回到顶部」链接指向它。
 *
 * @param source Markdown 文档源码
 * @returns 由 HTML 标题生成的锚点集合
 */
export function markdownHtmlHeadingAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  for (const match of source.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text: string = (match[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 0) anchors.add(slugify(text));
  }
  return anchors;
}

/**
 * HTML 显式锚点（`<a id="x">`、`<a name="x">`、任意元素的 `id="x"`）。
 * 文档里的徽章与折叠块会用到，它们同样是合法的跳转目标。
 *
 * @param source Markdown 文档源码
 * @returns 显式 HTML 锚点集合
 */
export function markdownHtmlAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>();
  for (const match of source.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["']/gi)) {
    const anchor: string | undefined = match[1];
    if (anchor !== undefined) anchors.add(anchor.toLowerCase());
  }
  return anchors;
}

/**
 * 一份文档里全部可跳转的锚点。
 *
 * @param source Markdown 文档源码
 * @returns 汇总后的全部可跳转锚点集合
 */
export function collectMarkdownAnchors(source: string): ReadonlySet<string> {
  const anchors: Set<string> = new Set<string>(markdownAnchors(source));
  for (const anchor of markdownHtmlHeadingAnchors(source)) anchors.add(anchor);
  for (const anchor of markdownHtmlAnchors(source)) anchors.add(anchor);
  return anchors;
}

/** 每份文档的锚点集合只算一次，按文档路径缓存。 */
const markdownAnchorCache: Map<string, ReadonlySet<string> | null> = new Map();

/**
 * 读取并缓存一份文档的锚点；文件读不到时返回 null（路径那一半另有报错）。
 * @param path Markdown 文档绝对路径。
 * @returns 文档中的锚点集合；读取失败时返回 null。
 */
async function anchorsOf(path: string): Promise<ReadonlySet<string> | null> {
  const cached: ReadonlySet<string> | null | undefined = markdownAnchorCache.get(path);
  if (cached !== undefined) return cached;
  let anchors: ReadonlySet<string> | null;
  try {
    anchors = collectMarkdownAnchors(await Bun.file(path).text());
  } catch {
    anchors = null;
  }
  markdownAnchorCache.set(path, anchors);
  return anchors;
}

/**
 * 检查 Markdown inline/reference link 与 HTML href/src 的本地目标。
 * @param projectRoot 仓库根目录绝对路径。
 * @param path Markdown 文档绝对路径。
 * @param failures 承接检查失败信息的数组。
 */
export async function checkMarkdownLocalLinks(
  projectRoot: string,
  path: string,
  failures: string[]
): Promise<void> {
  const source: string = await Bun.file(path).text();
  const searchable: string = withoutMarkdownCodeFences(source);
  const patterns: readonly RegExp[] = [
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g,
    /(?:href|src)=["']([^"']+)["']/g,
    /^\s*\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      const target: string | undefined = match[1];
      if (
        target === undefined ||
        target.startsWith("/") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
      ) {
        continue;
      }
      const line: number =
        searchable.slice(0, match.index).split("\n").length;
      const fragmentIndex: number = target.indexOf("#");
      const fragment: string = fragmentIndex < 0 ? "" : target.slice(fragmentIndex + 1);
      const targetWithoutFragment: string = target.split(/[?#]/, 1)[0] ?? "";
      // 纯 `#片段` 指向当前文档自己的标题。
      let linkedPath: string = path;
      if (targetWithoutFragment.length > 0) {
        let decodedTarget: string;
        try {
          decodedTarget = decodeURIComponent(targetWithoutFragment);
        } catch {
          decodedTarget = targetWithoutFragment;
        }
        linkedPath = resolve(dirname(path), decodedTarget);
        if (!existsSync(linkedPath)) {
          failures.push(
            `${relative(projectRoot, path)}:${line} local link target does not exist: ${target}`
          );
          continue;
        }
      }
      if (fragment.length === 0 || extname(linkedPath) !== ".md") continue;
      let decodedFragment: string;
      try {
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        decodedFragment = fragment;
      }
      const anchors: ReadonlySet<string> | null = await anchorsOf(linkedPath);
      if (anchors === null || anchors.has(decodedFragment.toLowerCase())) continue;
      failures.push(
        `${relative(projectRoot, path)}:${line} link fragment has no matching heading in ` +
        `${relative(projectRoot, linkedPath)}: #${decodedFragment}`
      );
    }
  }
}
