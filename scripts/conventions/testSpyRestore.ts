import { relative } from "node:path";
import ts from "typescript";
import { unwrapExpression } from "./staticAccess";
import {
  calledFunction,
  canonicalSymbol,
  collectResetFunctions,
  isInResetFunction,
  mockSymbols,
  referencedSymbol,
} from "./testMockReset";

/**
 * 顶层 `spyOn` 恢复门禁：模块顶层与 `describe` 一级语句创建的 `spyOn` 必须在同一作用域或祖先
 * 作用域注册的 `afterAll`/`afterEach` 清理钩子（或同作用域顶层同步位置）里调用 `.mockRestore()`
 * 或 `mock.restore()` 还原，避免在 `bun test --randomize` 下污染后续测试套件。
 */

/** 用于恢复文件顶层 `spyOn` 的清理生命周期钩子。 */
const CLEANUP_HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["afterEach", "afterAll"]);

/** `describe` 套件节点名集合，回调内部的一级语句仍视为顶层套件作用域。 */
const SUITE_FUNCTIONS: ReadonlySet<string> = new Set(["describe"]);

/** `collectTopLevelSpyRestoreProblems` 检查文件顶层 `spyOn` 恢复的参数。 */
export interface TopLevelSpyRestoreParams {
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 包含测试文件的 TypeScript Program。 */
  readonly program: ts.Program;
  /** TypeScript 类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** 待检查的测试与测试辅助文件绝对路径列表。 */
  readonly testFiles: readonly string[];
}

/** 顶层 `spyOn(...)` 调用及其所属套件作用域。 */
interface ScopedSpyCall {
  /** `spyOn(...)` 调用表达式。 */
  readonly call: ts.CallExpression;
  /** 所属套件作用域（`SourceFile` 或外层 `describe` 调用）。 */
  readonly scope: ts.Node;
}

/**
 * 判断调用目标表达式是否为 `describe` 套件根或其成员/柯里化修饰调用。
 *
 * @param expression 待检查的调用目标表达式
 * @returns 为 `describe` 套件入口时返回 true
 */
function isDescribeCallee(expression: ts.Expression): boolean {
  const target: ts.Expression = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return SUITE_FUNCTIONS.has(target.text);
  if (ts.isPropertyAccessExpression(target)) {
    return SUITE_FUNCTIONS.has(target.name.text) || isDescribeCallee(target.expression);
  }
  if (ts.isCallExpression(target)) {
    return isDescribeCallee(target.expression);
  }
  return false;
}

/**
 * 判断调用表达式是否为 `describe(...)`、`describe.each(...)(...)`、`describe.skipIf(...)(...)`
 * 或其命名空间/链式修饰调用。
 *
 * @param call 调用表达式节点
 * @returns 为 `describe` 套件调用时返回 true
 */
function isDescribeCall(call: ts.CallExpression): boolean {
  return isDescribeCallee(call.expression);
}

/**
 * 判断调用表达式是否为 `spyOn(...)`、`jest.spyOn(...)` 或 `<ns>.spyOn(...)`。
 *
 * @param call 调用表达式节点
 * @returns 为 `spyOn` 调用时返回 true
 */
function isSpyOnCall(call: ts.CallExpression): boolean {
  const callee: ts.Expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) return callee.text === "spyOn";
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "spyOn";
}

/**
 * 判断调用表达式是否为 `afterEach(...)`/`afterAll(...)` 或 `<ns>.afterEach(...)`/`<ns>.afterAll(...)`。
 *
 * @param call 调用表达式节点
 * @returns 为清理生命周期钩子调用时返回 true
 */
function isCleanupHookCall(call: ts.CallExpression): boolean {
  const callee: ts.Expression = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) return CLEANUP_HOOK_FUNCTIONS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && CLEANUP_HOOK_FUNCTIONS.has(callee.name.text);
}

/**
 * 判断调用表达式是否为无参全局 `mock.restore()` 或 `<ns>.mock.restore()`。
 *
 * @param call 调用表达式节点
 * @returns 为全局 `mock.restore()` 调用时返回 true
 */
function isGlobalMockRestoreCall(call: ts.CallExpression): boolean {
  if (call.arguments.length !== 0) return false;
  const callee: ts.Expression = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "restore") return false;
  const receiver: ts.Expression = unwrapExpression(callee.expression);
  if (ts.isIdentifier(receiver)) return receiver.text === "mock";
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === "mock";
}

/**
 * 判断函数节点的逻辑父节点是否为包装表达式并向上跳过。
 *
 * @param node 起始父节点
 * @returns 剥离括号、类型断言与 satisfies 后的首个真实父节点
 */
function unwrapParentNode(node: ts.Node | undefined): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * 若节点紧邻包装在一个 `describe` 套件回调内，返回该 `describe` 调用节点。
 *
 * @param node 待检查的 AST 节点
 * @returns 直接所属的 `describe` 调用节点，否则返回 undefined
 */
function describeCallbackParent(node: ts.FunctionLikeDeclaration): ts.CallExpression | undefined {
  const parent: ts.Node | undefined = unwrapParentNode(node.parent);
  if (parent !== undefined && ts.isCallExpression(parent) && isDescribeCall(parent)) {
    return parent;
  }
  return undefined;
}

/**
 * 判断 AST 节点是否为带独立函数体槽位的声明或表达式节点。
 *
 * @param node 待判断的 AST 节点
 * @returns 为函数声明、函数表达式、箭头函数、方法、存取器或构造函数时返回 `true`
 */
function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return true;
  return ts.isConstructorDeclaration(node);
}

/** 顶层 `spyOn` 调用收集结果。 */
interface TopLevelSpyCallsResult {
  /** 待检查的顶层 `spyOn` 调用列表。 */
  readonly calls: readonly ScopedSpyCall[];
  /** 每个子套件作用域到父套件作用域的映射。 */
  readonly parentScopeByScope: ReadonlyMap<ts.Node, ts.Node>;
}

/**
 * 返回节点所在的直接套件作用域（所属 `describe` 调用或文件根节点 `SourceFile`）。
 *
 * @param node 待查询的 AST 节点
 * @param source 文件根 AST 节点
 * @returns 所属套件作用域节点
 */
function enclosingSuiteScope(node: ts.Node, source: ts.SourceFile): ts.Node {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionLikeDeclaration(current)) {
      const describeCall: ts.CallExpression | undefined = describeCallbackParent(current);
      if (describeCall !== undefined) return describeCall;
    }
  }
  return source;
}

/**
 * 解析顶层 `spyOn(...)`（含 `.mockImplementation(...)` 等链式调用）最终绑定的变量符号。
 *
 * @param checker TypeScript 类型检查器
 * @param spyCall `spyOn(...)` 调用表达式
 * @returns 绑定符号；未赋值给标识符时返回 undefined
 */
function boundSpySymbol(checker: ts.TypeChecker, spyCall: ts.CallExpression): ts.Symbol | undefined {
  let current: ts.Node = spyCall;
  while (current.parent !== undefined) {
    const parent: ts.Node = current.parent;
    if (
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isParenthesizedExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current && ts.isCallExpression(parent.parent)) {
      current = parent.parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
      const symbol: ts.Symbol | undefined = checker.getSymbolAtLocation(parent.name);
      return symbol === undefined ? undefined : canonicalSymbol(checker, symbol);
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current
    ) {
      const symbol: ts.Symbol | undefined = referencedSymbol(checker, parent.left);
      return symbol === undefined ? undefined : canonicalSymbol(checker, symbol);
    }
    return undefined;
  }
  return undefined;
}

/**
 * 收集单个文件顶层与 `describe` 一级语句里的 `spyOn(...)` 调用及其作用域链。
 *
 * @param source 文件 AST
 * @returns 顶层 `spyOn` 列表及每个子套件作用域到父套件作用域的映射
 */
function collectTopLevelSpyCalls(source: ts.SourceFile): TopLevelSpyCallsResult {
  const calls: ScopedSpyCall[] = [];
  const parentScopeByScope: Map<ts.Node, ts.Node> = new Map<ts.Node, ts.Node>();
  const visitTopLevel = (node: ts.Node, scope: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      if (isDescribeCall(node)) {
        parentScopeByScope.set(node, scope);
        for (const argument of node.arguments) {
          const target: ts.Expression = unwrapExpression(argument);
          if ((ts.isArrowFunction(target) || ts.isFunctionExpression(target)) && target.body !== undefined) {
            ts.forEachChild(target.body, (child: ts.Node): void => {
              visitTopLevel(child, node);
            });
          } else {
            visitTopLevel(argument, scope);
          }
        }
        return;
      }
      if (isSpyOnCall(node)) {
        calls.push({ call: node, scope });
      }
    }
    ts.forEachChild(node, (child: ts.Node): void => {
      visitTopLevel(child, scope);
    });
  };
  ts.forEachChild(source, (child: ts.Node): void => {
    visitTopLevel(child, source);
  });
  return { calls, parentScopeByScope };
}

/** 按作用域汇总的 `.mockRestore()` 与全局 `mock.restore()` 恢复记录。 */
interface RestoredSpyScopeRecords {
  /** 各作用域内经 `afterAll`/`afterEach` 恢复的绑定符号集合。 */
  readonly hookSymbolsByScope: ReadonlyMap<ts.Node, ReadonlySet<ts.Symbol>>;
  /** 注册了包含 `mock.restore()` 的 `afterAll`/`afterEach` 钩子的作用域集合。 */
  readonly hookGlobalScopes: ReadonlySet<ts.Node>;
  /** 在对应作用域顶层同步调用 `.mockRestore()` 的符号集合。 */
  readonly syncSymbolsByScope: ReadonlyMap<ts.Node, ReadonlySet<ts.Symbol>>;
  /** 在对应作用域顶层同步调用 `mock.restore()` 的作用域集合。 */
  readonly syncGlobalScopes: ReadonlySet<ts.Node>;
}

/**
 * 向作用域符号表追加一条已恢复的符号记录。
 *
 * @param target 作用域到符号集合的可变映射表
 * @param scope 恢复所在套件作用域
 * @param symbol 已恢复的替身符号
 */
function addScopedSymbol(
  target: Map<ts.Node, Set<ts.Symbol>>,
  scope: ts.Node,
  symbol: ts.Symbol
): void {
  let symbols: Set<ts.Symbol> | undefined = target.get(scope);
  if (symbols === undefined) {
    symbols = new Set<ts.Symbol>();
    target.set(scope, symbols);
  }
  symbols.add(symbol);
}

/**
 * 收集同一个测试文件内分作用域记录的 `afterAll`/`afterEach`（可传递进入 `test/` 下辅助函数）
 * 与各作用域顶层同步位置对 `.mockRestore()` / `mock.restore()` 的调用。
 *
 * @param checker TypeScript 类型检查器
 * @param source 测试文件 AST
 * @param testFileSet 仓库内全部测试与测试辅助文件绝对路径集合
 * @returns 分作用域的 `spyOn` 恢复记录
 */
function collectRestoredSpyScopeRecords(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  testFileSet: ReadonlySet<string>
): RestoredSpyScopeRecords {
  const hookRootsByScope: Map<ts.Node, ts.FunctionLikeDeclaration[]> = new Map();
  const visitHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCleanupHookCall(node)) {
      const scope: ts.Node = enclosingSuiteScope(node, source);
      let roots: ts.FunctionLikeDeclaration[] | undefined = hookRootsByScope.get(scope);
      if (roots === undefined) {
        roots = [];
        hookRootsByScope.set(scope, roots);
      }
      for (const argument of node.arguments) {
        const hook: ts.FunctionLikeDeclaration | null = calledFunction(checker, argument);
        if (hook !== null) roots.push(hook);
      }
    }
    ts.forEachChild(node, visitHooks);
  };
  visitHooks(source);

  const hookSymbolsByScope: Map<ts.Node, Set<ts.Symbol>> = new Map();
  const hookGlobalScopes: Set<ts.Node> = new Set();
  for (const [scope, roots] of hookRootsByScope) {
    const cleanupFunctions: ReadonlySet<ts.Node> = collectResetFunctions(checker, roots, testFileSet);
    const inspectedNodes: Set<ts.Node> = new Set();
    for (const fn of cleanupFunctions) {
      const visitFn = (node: ts.Node): void => {
        if (inspectedNodes.has(node)) return;
        inspectedNodes.add(node);
        if (ts.isCallExpression(node) && isInResetFunction(node, cleanupFunctions)) {
          if (isGlobalMockRestoreCall(node)) {
            hookGlobalScopes.add(scope);
          } else if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "mockRestore" &&
            node.arguments.length === 0
          ) {
            for (const symbol of mockSymbols(checker, node.expression.expression)) {
              addScopedSymbol(hookSymbolsByScope, scope, symbol);
            }
          }
        }
        ts.forEachChild(node, visitFn);
      };
      if (isFunctionLikeDeclaration(fn) && fn.body !== undefined) visitFn(fn.body);
    }
  }

  const syncSymbolsByScope: Map<ts.Node, Set<ts.Symbol>> = new Map();
  const syncGlobalScopes: Set<ts.Node> = new Set();
  const visitSyncRestores = (node: ts.Node, scope: ts.Node, inFunction: boolean): void => {
    if (!inFunction && ts.isCallExpression(node)) {
      if (isGlobalMockRestoreCall(node)) {
        syncGlobalScopes.add(scope);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "mockRestore" &&
        node.arguments.length === 0
      ) {
        for (const symbol of mockSymbols(checker, node.expression.expression)) {
          addScopedSymbol(syncSymbolsByScope, scope, symbol);
        }
      }
    }
    if (isFunctionLikeDeclaration(node)) {
      const describeCall: ts.CallExpression | undefined = describeCallbackParent(node);
      const nextScope: ts.Node = describeCall ?? scope;
      const nextInFunction: boolean = describeCall !== undefined ? inFunction : true;
      ts.forEachChild(node, (child: ts.Node): void => {
        visitSyncRestores(child, nextScope, nextInFunction);
      });
      return;
    }
    ts.forEachChild(node, (child: ts.Node): void => {
      visitSyncRestores(child, scope, inFunction);
    });
  };
  visitSyncRestores(source, source, false);

  return { hookSymbolsByScope, hookGlobalScopes, syncSymbolsByScope, syncGlobalScopes };
}

/** `isSpyRestoredInCoveringScope` 参数对象。 */
interface SpyRestoreScopeCheckParams {
  /** `spyOn` 所在的直接套件作用域。 */
  readonly scope: ts.Node;
  /** 绑定的替身变量符号（未绑定变量时为 `undefined`）。 */
  readonly symbol: ts.Symbol | undefined;
  /** 子套件作用域到父套件作用域的映射。 */
  readonly parentScopeByScope: ReadonlyMap<ts.Node, ts.Node>;
  /** 该文件的恢复记录。 */
  readonly records: RestoredSpyScopeRecords;
}

/**
 * 判断某顶层 `spyOn` 调用是否在所属作用域或其祖先作用域的清理钩子中安全恢复。
 *
 * @param params 作用域、绑定符号、父作用域映射与文件恢复记录
 * @returns 已在合法作用域调用恢复时返回 true
 */
function isSpyRestoredInCoveringScope({
  scope,
  symbol,
  parentScopeByScope,
  records,
}: SpyRestoreScopeCheckParams): boolean {
  if (records.syncGlobalScopes.has(scope)) return true;
  if (symbol !== undefined && records.syncSymbolsByScope.get(scope)?.has(symbol) === true) {
    return true;
  }
  let current: ts.Node | undefined = scope;
  while (current !== undefined) {
    if (records.hookGlobalScopes.has(current)) return true;
    if (symbol !== undefined && records.hookSymbolsByScope.get(current)?.has(symbol) === true) {
      return true;
    }
    current = parentScopeByScope.get(current);
  }
  return false;
}

/**
 * 检查 `test/` 下所有测试与辅助文件顶层的 `spyOn` 是否在所属或外层作用域的
 * `afterAll`/`afterEach`（或同作用域顶层同步位置）调用 `.mockRestore()` 或 `mock.restore()`。
 *
 * @param params program、类型检查器与待检查文件列表
 * @returns 未按规恢复顶层 `spyOn` 的问题列表
 */
export function collectTopLevelSpyRestoreProblems({
  projectRoot,
  program,
  checker,
  testFiles,
}: TopLevelSpyRestoreParams): readonly string[] {
  const problems: string[] = [];
  const testFileSet: ReadonlySet<string> = new Set(testFiles);
  for (const path of testFiles) {
    const source: ts.SourceFile | undefined = program.getSourceFile(path);
    if (source === undefined) continue;
    const { calls, parentScopeByScope }: TopLevelSpyCallsResult = collectTopLevelSpyCalls(source);
    if (calls.length === 0) continue;
    const records: RestoredSpyScopeRecords = collectRestoredSpyScopeRecords(checker, source, testFileSet);
    for (const { call, scope } of calls) {
      const symbol: ts.Symbol | undefined = boundSpySymbol(checker, call);
      if (isSpyRestoredInCoveringScope({ scope, symbol, parentScopeByScope, records })) continue;
      const { line, character }: ts.LineAndCharacter =
        source.getLineAndCharacterOfPosition(call.getStart(source));
      const label: string = symbol === undefined ? "spyOn(...)" : symbol.name;
      problems.push(
        `${relative(projectRoot, path)}:${line + 1}:${character + 1}: top-level ${label} ` +
        "must call mockRestore() in afterAll/afterEach of the same file"
      );
    }
  }
  return problems;
}
