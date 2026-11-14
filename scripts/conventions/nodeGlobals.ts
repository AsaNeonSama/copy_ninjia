import ts from "typescript";
import {
  PRODUCTION_BUFFER_GLOBALS,
  SCRIPT_BUFFER_GLOBALS,
  TEST_BUFFER_GLOBALS,
} from "./nodeAllowances";
import type { BufferGlobalAllowance } from "./nodeAllowances";
import { globalPropertyName, isGlobalReference, isInsideTypeNode, staticPropertyName } from "./staticAccess";

/**
 * 运行期 Node 全局 API 与 `process` 替代入口检查。
 *
 * 核对全局 `Buffer` 方法白名单（禁止未登记调用与已登记却不再使用的方法）以及可通过
 * Bun 原生接口或显式审查替代的 `process.argv` / `process.execPath` / `process.hrtime` /
 * `process.nextTick` 访问；纯类型位置与对象/类型属性声明位置不计入。
 */

/** 需要原生替换或先核对调度语义的 `process` 属性。 */
const PROCESS_REPLACEMENTS: Readonly<Record<string, string>> = {
  argv: "Bun.argv",
  execPath: "Bun.argv[0]",
  hrtime: "Bun.nanoseconds() after checking the time origin",
  nextTick: "queueMicrotask after checking scheduling and cancellation semantics",
};

/**
 * 判断 AST 节点是否为运行期对全局 `Buffer` 的引用。
 *
 * @param node 待检查的 AST 节点
 * @returns 为运行期全局 `Buffer` 引用时返回 true
 */
function isBufferGlobalUse(node: ts.Node): boolean {
  if (isInsideTypeNode(node)) return false;
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    isGlobalReference(node, "Buffer")
  ) {
    return true;
  }
  if (!ts.isIdentifier(node) || node.text !== "Buffer") return false;
  const parent: ts.Node = node.parent;
  const isImportName: boolean =
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent);
  if (isImportName) return false;
  const isPropertyName: boolean =
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node);
  return !isPropertyName;
}

/**
 * 提取全局 `Buffer` 节点上被静态访问的方法或属性名。
 *
 * @param node 全局 `Buffer` 引用节点
 * @returns 被访问的静态属性名，无法静态确定时返回 undefined
 */
function bufferGlobalMethod(node: ts.Node): string | undefined {
  const parent: ts.Node = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    return staticPropertyName(parent);
  }
  return undefined;
}

/**
 * 识别应改用 Bun 原生接口或先核对调度语义的 `process` 属性访问。
 *
 * @param node 待检查的 AST 节点
 * @returns 命中受限属性时返回属性名，否则返回 undefined
 */
function discouragedProcessProperty(node: ts.Node): string | undefined {
  const property: string | undefined = globalPropertyName(node, "process");
  return property !== undefined && Object.hasOwn(PROCESS_REPLACEMENTS, property) ? property : undefined;
}

/** `collectNodeGlobalProblems` 检查文件内全局 Node API 与 `process` 替代入口的参数。 */
export interface NodeGlobalCheckParams {
  /** 被检查文件相对仓库根的路径。 */
  readonly relativePath: string;
  /** 已解析的 TypeScript 源文件 AST。 */
  readonly source: ts.SourceFile;
}

/**
 * 检查单个文件内全局 `Buffer`（含陈旧方法豁免检查）与受限 `process` 属性访问。
 *
 * @param params 文件相对路径与 AST
 * @returns 全局 API 兼容违规问题列表
 */
export function collectNodeGlobalProblems({
  relativePath,
  source,
}: NodeGlobalCheckParams): readonly string[] {
  const problems: string[] = [];
  const isScript: boolean = relativePath.startsWith("scripts/");
  const isTest: boolean = relativePath.startsWith("test/");
  let usesBufferGlobal: boolean = false;
  const usedBufferMethods: Set<string> = new Set<string>();
  const bufferAllowance: BufferGlobalAllowance | undefined = isScript
    ? SCRIPT_BUFFER_GLOBALS[relativePath]
    : isTest
      ? TEST_BUFFER_GLOBALS[relativePath]
      : PRODUCTION_BUFFER_GLOBALS[relativePath];

  const visitBufferGlobal = (node: ts.Node): void => {
    if (isBufferGlobalUse(node)) {
      usesBufferGlobal = true;
      const method: string | undefined = bufferGlobalMethod(node);
      if (method !== undefined) usedBufferMethods.add(method);
      if (bufferAllowance === undefined || method === undefined || !bufferAllowance.methods.includes(method)) {
        const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        problems.push(
          `${relativePath}:${line} uses unreviewed Node compatibility global Buffer` +
          (method === undefined ? "" : `.${method}`)
        );
      }
    }
    ts.forEachChild(node, visitBufferGlobal);
  };
  visitBufferGlobal(source);

  if (bufferAllowance !== undefined) {
    if (!usesBufferGlobal) {
      problems.push(`${relativePath}:1 retains a stale Node compatibility global Buffer allowance`);
    } else {
      for (const allowedMethod of bufferAllowance.methods) {
        if (usedBufferMethods.has(allowedMethod)) continue;
        problems.push(
          `${relativePath}:1 retains a stale Node compatibility global Buffer.${allowedMethod} allowance`
        );
      }
    }
  }

  const visitDiscouragedProcessProperties = (node: ts.Node): void => {
    const property: string | undefined = discouragedProcessProperty(node);
    if (property !== undefined) {
      const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      problems.push(
        `${relativePath}:${line} uses process.${property}; use ${PROCESS_REPLACEMENTS[property]}`
      );
    }
    ts.forEachChild(node, visitDiscouragedProcessProperties);
  };
  visitDiscouragedProcessProperties(source);

  return problems;
}
