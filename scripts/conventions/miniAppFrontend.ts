import { dirname, extname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { parseSourceFile } from "./sourceAnalysis";

/**
 * Mini App 前端目录的引用边界。
 *
 * `packages/mini-app-frontend/` 在代码上不依赖目录外的任何文件：TS/TSX 的全部模块说明符（含
 * `import type`、`export … from`、`import()`、`require()` 与类型位置的 `import("…")`）、HTML 的
 * `src`/`href` 与 CSS 的 `url()`/`@import` 中的相对引用都必须落在本目录内；npm 包按根 `package.json` 共用，裸说明符不在此列。反方向上 `packages/` 其余模块与
 * `index.ts` 不得引用前端，唯一例外登记在 MINI_APP_FRONTEND_ENTRY_IMPORTS。约束说明见 AGENTS.md。
 */

/** 前端目录，相对仓库根，带结尾斜杠。 */
export const MINI_APP_FRONTEND_ROOT: string = "packages/mini-app-frontend/";

/** 前端常量目录：适用与 `packages/consts/` 相同的常量规则，运行期只依赖本目录。 */
export const MINI_APP_FRONTEND_CONSTS_ROOT: string = "packages/mini-app-frontend/consts/";

/**
 * 前端目录外允许引用前端的位置：引用方 → 被引用文件，均相对仓库根。
 *
 * 唯一条目：`packages/mini-app-server/server/register.ts` 以 Bun HTML import 引入
 * `packages/mini-app-frontend/index.html`，由 `Bun.serve` 打包并托管前端。新增条目必须同时改这里与
 * AGENTS.md 的 Mini App 前后端边界一节。
 */
export const MINI_APP_FRONTEND_ENTRY_IMPORTS: ReadonlyMap<string, string> = new Map<string, string>([
  ["packages/mini-app-server/server/register.ts", "packages/mini-app-frontend/index.html"],
]);

/** HTML `src`/`href` 属性值。 */
const HTML_REFERENCE_PATTERN: RegExp = /\b(?:src|href)\s*=\s*["']([^"']+)["']/g;

/** CSS `url(...)` 与 `@import "..."` 的目标。 */
const CSS_REFERENCE_PATTERN: RegExp = /url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g;

/** 带协议、协议相对、片段与站点根的 HTML/CSS 引用不指向仓库文件，不参与核对。 */
const NON_FILE_REFERENCE_PATTERN: RegExp = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** 一条模块或资源引用。 */
interface FileReference {
  /** 原样写在源码里的说明符或资源路径。 */
  readonly specifier: string;
  /** 所在行号（1 起）。 */
  readonly line: number;
}

/**
 * 取出 TS/TSX 源码里的全部模块说明符，类型引用与运行期引用都计入。
 *
 * @param source 源文件 AST
 * @returns 模块说明符及其行号
 */
function moduleReferences(source: ts.SourceFile): readonly FileReference[] {
  const references: FileReference[] = [];
  const push = (node: ts.Node, specifier: string): void => {
    references.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)) {
      push(node, node.argument.literal.text);
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument: ts.Expression | undefined = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) push(node, argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/**
 * 按正则取出 HTML/CSS 文本里的资源引用。
 *
 * @param text 文件文本
 * @param pattern 带全局标志的引用匹配规则，第一个非空捕获组为路径
 * @returns 资源路径及其行号
 */
function assetReferences(text: string, pattern: RegExp): readonly FileReference[] {
  const references: FileReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const specifier: string | undefined = match.slice(1).find(
      (group: string | undefined): boolean => group !== undefined
    );
    if (specifier === undefined || NON_FILE_REFERENCE_PATTERN.test(specifier.trim())) continue;
    references.push({ specifier: specifier.trim(), line: text.slice(0, match.index).split("\n").length });
  }
  return references;
}

/**
 * 读取一个受跟踪文件里的全部文件引用；不解析引用的文件类型返回空列表。`.ts` 经 parseSourceFile
 * 解析，与逐文件约定检查共用同一份 AST。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @param trackedPath 相对仓库根的文件路径
 * @returns 文件引用列表
 */
async function fileReferences(projectRoot: string, trackedPath: string): Promise<readonly FileReference[]> {
  const path: string = join(projectRoot, trackedPath);
  switch (extname(trackedPath)) {
    case ".ts":
      return moduleReferences(await parseSourceFile(path));
    case ".tsx":
      return moduleReferences(ts.createSourceFile(
        path,
        await Bun.file(path).text(),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      ));
    case ".html":
      return assetReferences(await Bun.file(path).text(), HTML_REFERENCE_PATTERN);
    case ".css":
      return assetReferences(await Bun.file(path).text(), CSS_REFERENCE_PATTERN);
    default:
      return [];
  }
}

/**
 * 把相对或绝对路径引用解析成相对仓库根的路径；裸说明符（npm 包）返回 undefined。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @param fromPath 发起引用的文件，相对仓库根
 * @param specifier 引用说明符
 * @returns 相对仓库根的目标路径，裸说明符返回 undefined
 */
function resolveFileReference(projectRoot: string, fromPath: string, specifier: string): string | undefined {
  const path: string = specifier.split(/[?#]/, 1)[0] ?? specifier;
  if (!path.startsWith(".") && !path.startsWith("/")) return undefined;
  return relative(projectRoot, resolve(projectRoot, dirname(fromPath), path));
}

/**
 * 核对 Mini App 前端目录的双向引用边界，并核对例外登记仍在使用。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @param trackedFiles 现存受跟踪文件（相对仓库根）
 * @returns 越界引用与废弃例外登记的问题列表
 */
export async function collectMiniAppFrontendBoundaryProblems(
  projectRoot: string,
  trackedFiles: readonly string[]
): Promise<readonly string[]> {
  const problems: string[] = [];
  const usedEntryImports: Set<string> = new Set<string>();
  for (const trackedPath of trackedFiles) {
    const isFrontend: boolean = trackedPath.startsWith(MINI_APP_FRONTEND_ROOT);
    const isProduction: boolean = trackedPath === "index.ts" || trackedPath.startsWith("packages/");
    if (!isProduction) continue;
    for (const reference of await fileReferences(projectRoot, trackedPath)) {
      const target: string | undefined = resolveFileReference(projectRoot, trackedPath, reference.specifier);
      if (target === undefined) continue;
      const targetIsFrontend: boolean = `${target}/`.startsWith(MINI_APP_FRONTEND_ROOT);
      if (isFrontend && !targetIsFrontend) {
        problems.push(
          `${trackedPath}:${reference.line} references ${target}; ${MINI_APP_FRONTEND_ROOT} must not depend on ` +
          "files outside its directory — copy the shared constant, type or function into the frontend instead"
        );
      } else if (!isFrontend && targetIsFrontend) {
        if (MINI_APP_FRONTEND_ENTRY_IMPORTS.get(trackedPath) === target) {
          usedEntryImports.add(trackedPath);
          continue;
        }
        problems.push(
          `${trackedPath}:${reference.line} references ${target}; only the entries in MINI_APP_FRONTEND_ENTRY_IMPORTS ` +
          `(scripts/conventions/miniAppFrontend.ts) may reference ${MINI_APP_FRONTEND_ROOT}`
        );
      }
    }
  }
  for (const [importer, target] of MINI_APP_FRONTEND_ENTRY_IMPORTS) {
    if (usedEntryImports.has(importer)) continue;
    problems.push(
      `MINI_APP_FRONTEND_ENTRY_IMPORTS registers ${importer} -> ${target}, which no longer exists; remove the entry`
    );
  }
  return problems;
}
