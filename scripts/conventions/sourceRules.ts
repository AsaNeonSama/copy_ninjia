import { relative } from "node:path";
import ts from "typescript";
import {
  collectSharedConstantProblems,
  declarationName,
  hasJsDoc,
  isExported,
  isLiteralConstant,
  isObjectFreezeCall,
  isVoidOrNeverReturnType,
  moduleCacheInitializerKind,
  unwrapParamInterfaceName,
} from "./sourceAnalysis";

/**
 * 逐文件判定源码的放置、常量、缓存生命周期和声明约定。
 * 编排器每个文件只解析一次，按路径选择规则并传入同一份 AST。
 */

/** 逐文件判定的公共入参。 */
export interface SourceFileRuleParams {
  /** 仓库根，用于把绝对路径压成报告里的相对路径。 */
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 该文件唯一一次解析得到的 AST；调用方负责用它跑完所有适用规则。 */
  readonly source: ts.SourceFile;
}

/**
 * 普通生产模块的纯字面量常量统一归入 consts；调用方排除缓存 owner 与常量模块。
 * @param params 被检查文件及 AST。
 * @returns 字面量常量位置违规列表。
 */
export function collectConstantLocationProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined || !isLiteralConstant(declaration.initializer)) continue;
      problems.push(
        `${relative(projectRoot, path)}:${lineOf(source, declaration)} literal constant ` +
        `${declarationName(declaration)} must live in packages/consts/`
      );
    }
  }
  return problems;
}

/**
 * 节点所在行号（1 起）。
 * @param source 源文件 AST。
 * @param node 目标语法节点。
 * @returns 1 起始的行号。
 */
function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

interface CacheLifecycleField {
  /** 失败报告中的稳定字段名。 */
  readonly name: string;
  /** 中文 JSDoc 中可表达该字段语义的受控词组。 */
  readonly pattern: RegExp;
}

/** 缓存模块 JSDoc 必须同时覆盖的生命周期字段。 */
const CACHE_LIFECYCLE_FIELDS: readonly Readonly<CacheLifecycleField>[] = [
  { name: "fill", pattern: /填|写入|注入|建立|创建|登记|加入|收到|派生|缓存|灌入/ },
  { name: "clear", pattern: /清理|清空|清除|删除|移除|释放|重置|停止|退出|结算|摘除|到期|销毁|淘汰|失效|撤销|归零|清零|作废|排空|关闭|结束/ },
  { name: "rebuild", pattern: /重建|重启|新 isolate|新进程|新生命周期|启动时|初始|恢复为空|销毁|崩溃|冷启动|重新创建|重新启动|从空|从 null|从 false/ },
  { name: "capacity", pattern: /容量|上限|有界|最多|固定|恒定|不超过|同阶|单例|唯一|一个|TTL|条目数|槽位|每群|每个|按群|按 chatId/ },
  { name: "eviction", pattern: /淘汰|清理策略|到期|删除|清空|清除|移除|释放|结算|摘除|销毁|作废|归零|清零|排空|重写|覆盖|关闭|结束|不淘汰|不设 TTL|不设超时|无需额外.*清理/ },
];

/**
 * 提取文件中全部 JSDoc 正文；普通块注释不能替代生命周期契约。
 * @param source 源文件 AST。
 * @returns 拼接后的全部 JSDoc 文本。
 */
function allJsDocText(source: ts.SourceFile): string {
  const comments: string[] = [];
  for (const match of source.text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const comment: string | undefined = match[0];
    if (comment !== undefined) comments.push(comment);
  }
  return comments.join("\n");
}

/**
 * `packages/cache/` 下每个导出都要有 JSDoc，状态模块还须覆盖完整生命周期字段。
 * @param params 被检查文件及 AST。
 * @returns 缓存模块 JSDoc 违规列表。
 */
export function collectCacheJsDocProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  let hasExportedCacheState: boolean = false;
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      hasExportedCacheState = true;
      if (hasJsDoc(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        problems.push(`${relativePath}:${lineOf(source, declaration)} export ${declarationName(declaration)} lacks JSDoc`);
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (!hasJsDoc(statement)) {
        problems.push(`${relativePath}:${lineOf(source, statement)} export ${declarationName(statement)} lacks JSDoc`);
      }
    }
  }
  if (hasExportedCacheState) {
    const jsDocText: string = allJsDocText(source);
    for (const field of CACHE_LIFECYCLE_FIELDS) {
      if (!field.pattern.test(jsDocText)) {
        problems.push(`${relativePath}:1 cache module JSDoc lacks lifecycle field ${field.name}`);
      }
    }
  }
  return problems;
}

/**
 * `packages/consts/` 下的常量要求 SCREAMING_SNAKE_CASE、显式类型、JSDoc 与编译期只读。
 * @param params 被检查文件及 AST。
 * @returns 常量命名、类型、JSDoc 与只读约定违规列表。
 */
export function collectConstantProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const location: string = `${relativePath}:${lineOf(source, declaration)}`;
      const name: string = declarationName(declaration);
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        problems.push(`${location} constant ${name} is not SCREAMING_SNAKE_CASE`);
      }
      if (declaration.type === undefined) {
        problems.push(`${location} constant ${name} lacks an explicit type`);
      }
      if (!hasJsDoc(statement)) {
        problems.push(`${location} constant ${name} lacks JSDoc`);
      }
      if (isExported(statement) && declaration.initializer !== undefined) {
        for (const problem of collectSharedConstantProblems(
          declaration.initializer,
          declaration.type,
          `constant ${name}`
        )) {
          problems.push(`${location} ${problem}`);
        }
      }
    }
  }
  return problems;
}

/**
 * `Object.freeze` 在 packages/ 下一处都不许有。
 *
 * 常量、部署配置快照、句柄对象都一样：不可变性一律由 `readonly`/`Readonly<T>`
 * 在编译期表达，不做运行期冻结。
 *
 * 这条独立于 collectConstantProblems：解析结果和句柄对象不是 SCREAMING_SNAKE 常量，
 * 不经过那一条，同样不许冻结。
 * @param params 被检查文件及 AST。
 * @returns `Object.freeze` 调用违规列表。
 */
export function collectObjectFreezeProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isObjectFreezeCall(node)) {
      problems.push(
        `${relativePath}:${lineOf(source, node)} Object.freeze is not allowed: ` +
        "express immutability with readonly types instead (see AGENTS.md 常量)"
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

/** 迭代器取头的三个方法名；`<expr>.<name>().next()` 即按插入序取最早项。 */
const ITERATOR_HEAD_METHODS: ReadonlySet<string> = new Set(["keys", "values", "entries"]);

/**
 * packages/ 下不许用 `.keys().next()`、`.values().next()`、`.entries().next()` 取最早项。
 *
 * 有界 FIFO / LRU 的最早项一律经 libs/fifoMap.ts 的 FifoMap（或继承它的 LruCache）取得：
 * 它的 `oldestKey()` 与满载淘汰都是 O(1)。规则按语法判定，不区分接收者类型。
 * @param params 被检查文件及 AST。
 * @returns 迭代器取头调用违规列表。
 */
export function collectIteratorHeadProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "next" &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression.expression.expression) &&
      ITERATOR_HEAD_METHODS.has(node.expression.expression.expression.name.text)
    ) {
      problems.push(
        `${relativePath}:${lineOf(source, node)} ` +
        `.${node.expression.expression.expression.name.text}().next() is not allowed: ` +
        "take the oldest entry from FifoMap (packages/libs/fifoMap.ts) instead"
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

/**
 * 模块级 Map/Set/AsyncLocalStorage/holder 必须声明在带 owner 的 `packages/cache/<owner>/` 下。
 * @param params 被检查文件及 AST。
 * @returns 非缓存目录下的模块级可变状态违规列表。
 */
export function collectModuleCacheProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined) continue;
      const kind: string | null = moduleCacheInitializerKind(declaration.initializer);
      if (kind === null) continue;
      problems.push(
        `${relativePath}:` +
        `${lineOf(source, declaration)} ` +
        `module-level ${kind} ${declarationName(declaration)} must be declared under packages/cache/<owner>/`
      );
    }
  }
  return problems;
}

/**
 * 生产代码不得导入的类型聚合入口：仅供测试的 `types/antiRaid` 与
 * `types/diskIO`，以及不存在、也不得重建的 `types` 目录入口（`types/index`）。生产代码必须
 * 直接导入所属领域模块。
 */
const TEST_ONLY_TYPE_BARREL_PATTERN: RegExp = /(^|\/)types(\/index|\/antiRaid|\/diskIO)?$/;

/**
 * `packages/` 通用的 AST 判定：领域类型入口、`console.error` 边界、导出函数
 * 返回类型、内联对象参数类型与 catch 绑定标注。
 * @param params 被检查文件及 AST。
 * @returns 声明约定违规列表。
 */
export function collectDeclarationProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath: string = node.moduleSpecifier.text;
      if (modulePath.startsWith(".") && TEST_ONLY_TYPE_BARREL_PATTERN.test(modulePath)) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node)} ` +
          `production code must import from a domain type module instead of the test-only barrel ${modulePath}`
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      node.expression.name.text === "error"
    ) {
      const isDiskIOBoundary: boolean =
        relativePath === "packages/workers/diskIOWorker.ts" ||
        relativePath.startsWith("packages/workers/diskIO/");
      if (!isDiskIOBoundary) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node)} ` +
          "direct console.error is restricted to the disk I/O Worker boundary"
        );
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      isExported(node) &&
      node.type === undefined
    ) {
      problems.push(
        `${relativePath}:` +
        `${lineOf(source, node)} ` +
        `exported function ${declarationName(node)} lacks an explicit return type`
      );
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (parameter.type !== undefined && ts.isTypeLiteralNode(parameter.type)) {
          problems.push(
            `${relativePath}:` +
            `${lineOf(source, parameter)} ` +
            `inline object parameter type must be an exported XxxParams interface`
          );
        }
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      if (node.variableDeclaration.type?.kind !== ts.SyntaxKind.UnknownKeyword) {
        problems.push(
          `${relativePath}:` +
          `${lineOf(source, node.variableDeclaration)} ` +
          `catch binding ${declarationName(node.variableDeclaration)} must be explicitly typed unknown`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

/**
 * 检查顶层函数与类方法的 JSDoc、`@param`、`@returns` 以及解构参数接口属性的 JSDoc。
 * @param params 被检查文件及 AST。
 * @returns 函数与参数接口 JSDoc 缺失问题列表。
 */
export function collectFunctionJsDocProblems({
  projectRoot,
  path,
  source,
}: SourceFileRuleParams): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const interfacesByName: Map<string, ts.InterfaceDeclaration> = new Map();
  const checkedInterfaces: Set<string> = new Set();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      interfacesByName.set(statement.name.text, statement);
    }
  }

  function checkInterfaceProperties(iface: ts.InterfaceDeclaration): void {
    if (checkedInterfaces.has(iface.name.text)) return;
    checkedInterfaces.add(iface.name.text);
    for (const member of iface.members) {
      if (ts.isPropertySignature(member) && !hasJsDoc(member)) {
        problems.push(
          `${relativePath}:${lineOf(source, member)} interface ${iface.name.text} ` +
          `property ${declarationName(member)} lacks JSDoc`
        );
      }
    }
  }

  for (const iface of interfacesByName.values()) {
    if (/(?:Params|Options)$/.test(iface.name.text)) {
      checkInterfaceProperties(iface);
    }
  }

  function checkCallable(
    node: ts.FunctionDeclaration | ts.MethodDeclaration,
    name: string,
    docNodes: readonly (ts.FunctionDeclaration | ts.MethodDeclaration)[]
  ): void {
    const location: string = `${relativePath}:${lineOf(source, node)}`;
    if (!docNodes.some(hasJsDoc)) {
      problems.push(`${location} function ${name} lacks JSDoc`);
    }
    const paramTags: string[] = [];
    let hasReturns: boolean = false;
    for (const docNode of docNodes) {
      for (const tag of ts.getJSDocTags(docNode)) {
        const text: string | undefined = ts.getTextOfJSDocComment(tag.comment)?.trim();
        if (text === undefined || text.length === 0) continue;
        if (ts.isJSDocParameterTag(tag)) {
          paramTags.push(tag.name.getText(source));
        } else if (ts.isJSDocReturnTag(tag)) {
          hasReturns = true;
        }
      }
    }
    const positionalNames: Set<string> = new Set();
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name)) positionalNames.add(parameter.name.text);
    }
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name)) {
        const paramName: string = parameter.name.text;
        const matched: boolean = paramTags.some(
          (tagName: string): boolean => tagName === paramName || tagName.startsWith(`${paramName}.`)
        );
        if (!matched) {
          problems.push(`${location} function ${name} lacks @param JSDoc for ${paramName}`);
        }
      } else {
        const hasDestructuredTag: boolean = paramTags.some((tagName: string): boolean => {
          const dotIdx: number = tagName.indexOf(".");
          return !positionalNames.has(dotIdx === -1 ? tagName : tagName.slice(0, dotIdx));
        });
        if (!hasDestructuredTag) {
          problems.push(`${location} function ${name} lacks @param JSDoc for destructured parameter`);
        }
        if (ts.isObjectBindingPattern(parameter.name)) {
          const ifaceName: string | undefined = unwrapParamInterfaceName(parameter.type);
          const iface: ts.InterfaceDeclaration | undefined =
            ifaceName === undefined ? undefined : interfacesByName.get(ifaceName);
          if (iface !== undefined) checkInterfaceProperties(iface);
        }
      }
    }
    if (!isVoidOrNeverReturnType(node.type) && !hasReturns) {
      problems.push(`${location} function ${name} lacks @returns JSDoc`);
    }
  }

  function scanCallables(nodes: readonly ts.Node[]): void {
    let pendingOverloads: (ts.FunctionDeclaration | ts.MethodDeclaration)[] = [];
    for (const node of nodes) {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        if (node.body === undefined) {
          pendingOverloads.push(node);
          continue;
        }
        const name: string = declarationName(node);
        const docNodes: (ts.FunctionDeclaration | ts.MethodDeclaration)[] = [];
        for (const overload of pendingOverloads) {
          if (declarationName(overload) === name) docNodes.push(overload);
        }
        docNodes.push(node);
        pendingOverloads = [];
        checkCallable(node, name, docNodes);
      } else {
        pendingOverloads = [];
        if (ts.isClassDeclaration(node)) scanCallables(node.members);
      }
    }
  }

  scanCallables(source.statements);
  return problems;
}
