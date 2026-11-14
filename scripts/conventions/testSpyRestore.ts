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
 * 套件级 `spyOn` 恢复门禁：模块顶层、`describe` 一级语句以及 `beforeAll`/`beforeEach` 回调（含其经 `test/`
 * 下辅助函数传递调用到的函数）里创建的 `spyOn` 必须用 `.mockRestore()`、`mock.restore()` 或等价的
 * `jest.restoreAllMocks()` 还原，避免在 `bun test --randomize` 下污染后续测试套件：
 * - 顶层与 `beforeAll` 创建的监听只认同一或祖先作用域的 `afterAll`（`afterEach` 会在第一个用例后就撤掉监听）；
 *   顶层监听另认同作用域顶层同步位置的还原。
 * - `beforeEach` 创建的监听认同一或祖先作用域的 `afterEach` 或 `afterAll`。
 * - 准备钩子创建的监听在同一钩子内还原时同样放行。
 * 被监听目标已是 mock 时，Bun 的 `spyOn` 返回同一个 mock，对它调用 `.mockRestore()` 会清空实现，
 * 这类目标应改用 `mock.restore()`；门禁无法静态区分目标，诊断文案同时给出两种写法。
 */

/** 运行还原的清理钩子：`afterAll` 在套件全部用例结束后运行，`afterEach` 在每个用例结束后运行。 */
const CLEANUP_HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["afterAll", "afterEach"]);

/** 会创建套件级监听的准备钩子。 */
const SETUP_HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["beforeAll", "beforeEach"]);

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

/** 套件级 `spyOn` 的创建位置：顶层语句、`beforeAll` 或 `beforeEach` 回调。 */
type SpyCallOrigin = "top-level" | "beforeAll" | "beforeEach";

/** 一组函数体或同步位置里出现的还原调用。 */
interface RestoreSet {
  /** 是否出现过无参全局还原（`mock.restore()` / `jest.restoreAllMocks()`）。 */
  global: boolean;
  /** 经 `.mockRestore()` 还原的绑定符号。 */
  readonly symbols: Set<ts.Symbol>;
}

/** 套件级 `spyOn(...)` 调用及其所属套件作用域。 */
interface ScopedSpyCall {
  /** `spyOn(...)` 调用表达式。 */
  readonly call: ts.CallExpression;
  /** 调用所在的创建位置。 */
  readonly origin: SpyCallOrigin;
  /** 所属套件作用域（`SourceFile` 或外层 `describe` 调用）。 */
  readonly scope: ts.Node;
  /** 准备钩子自身（含传递调用的辅助函数）里的还原调用；顶层监听为 undefined。 */
  readonly setupRestores: RestoreSet | undefined;
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
 * 取生命周期钩子调用（`afterAll(...)`、`<ns>.beforeEach(...)` 等）的钩子名。
 *
 * @param call 调用表达式节点
 * @param hookNames 允许匹配的钩子名集合
 * @returns 命中集合时返回钩子名，否则返回 undefined
 */
function lifecycleHookName(call: ts.CallExpression, hookNames: ReadonlySet<string>): string | undefined {
  const callee: ts.Expression = unwrapExpression(call.expression);
  const name: string | undefined = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name !== undefined && hookNames.has(name) ? name : undefined;
}

/**
 * 判断调用表达式是否为无参全局还原：`mock.restore()`、`jest.restoreAllMocks()` 或带命名空间前缀的同名调用。
 * 两者在 Bun 中语义相同：还原全部 `spyOn` 监听，不清空共享 mock 的实现。
 *
 * @param call 调用表达式节点
 * @returns 为全局还原调用时返回 true
 */
function isGlobalMockRestoreCall(call: ts.CallExpression): boolean {
  if (call.arguments.length !== 0) return false;
  const callee: ts.Expression = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiverName: string | undefined = expectedGlobalRestoreReceiver(callee.name.text);
  if (receiverName === undefined) return false;
  const receiver: ts.Expression = unwrapExpression(callee.expression);
  if (ts.isIdentifier(receiver)) return receiver.text === receiverName;
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === receiverName;
}

/**
 * 全局还原方法名对应的接收者名：`restore` 属于 `mock`，`restoreAllMocks` 属于 `jest`。
 *
 * @param methodName 调用的方法名
 * @returns 对应的接收者名；不是全局还原方法时返回 undefined
 */
function expectedGlobalRestoreReceiver(methodName: string): string | undefined {
  if (methodName === "restore") return "mock";
  if (methodName === "restoreAllMocks") return "jest";
  return undefined;
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
 * 新建空的还原记录。
 *
 * @returns 未出现任何还原调用的记录
 */
function emptyRestoreSet(): RestoreSet {
  return { global: false, symbols: new Set<ts.Symbol>() };
}

/**
 * 判断调用是否为无参 `<expr>.mockRestore()`。
 *
 * @param call 调用表达式节点
 * @returns 为无参 `.mockRestore()` 调用时返回 true
 */
function isMockRestoreCall(call: ts.CallExpression): call is ts.CallExpression & { readonly expression: ts.PropertyAccessExpression } {
  return ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "mockRestore" &&
    call.arguments.length === 0;
}

/**
 * 把一个还原调用记入还原记录；不是还原调用时不做任何事。
 *
 * @param checker TypeScript 类型检查器
 * @param call 调用表达式节点
 * @param target 待写入的还原记录
 */
function recordRestoreCall(checker: ts.TypeChecker, call: ts.CallExpression, target: RestoreSet): void {
  if (isGlobalMockRestoreCall(call)) {
    target.global = true;
  } else if (isMockRestoreCall(call)) {
    for (const symbol of mockSymbols(checker, call.expression.expression)) target.symbols.add(symbol);
  }
}

/**
 * 判断还原记录是否覆盖给定监听（全局还原，或对其绑定符号调用了 `.mockRestore()`）。
 *
 * @param restores 还原记录；undefined 表示没有任何还原
 * @param symbol 监听绑定的变量符号（未绑定变量时为 undefined）
 * @returns 覆盖时返回 true
 */
function restoresSpy(restores: RestoreSet | undefined, symbol: ts.Symbol | undefined): boolean {
  return restores !== undefined && (restores.global || (symbol !== undefined && restores.symbols.has(symbol)));
}

/** 一组钩子回调（含传递调用到的 `test/` 辅助函数）里的 `spyOn` 调用与还原调用。 */
interface HookFunctionCalls {
  /** `spyOn(...)` 调用，按文档顺序排列。 */
  readonly spyCalls: readonly ts.CallExpression[];
  /** 还原调用记录。 */
  readonly restores: RestoreSet;
}

/** `collectHookFunctionCalls` 的参数对象。 */
interface HookFunctionCallsParams {
  /** TypeScript 类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** 钩子调用节点。 */
  readonly hookCall: ts.CallExpression;
  /** 仓库内全部测试与测试辅助文件绝对路径集合。 */
  readonly testFileSet: ReadonlySet<string>;
}

/**
 * 收集一个钩子的回调（内联函数或对函数的引用）及其经 `test/` 下辅助函数传递调用到的函数里的
 * `spyOn` 调用与还原调用。
 *
 * @param params 类型检查器、钩子调用节点与测试文件集合
 * @returns 钩子函数集合里的监听与还原调用
 */
function collectHookFunctionCalls({ checker, hookCall, testFileSet }: HookFunctionCallsParams): HookFunctionCalls {
  const roots: ts.FunctionLikeDeclaration[] = [];
  for (const argument of hookCall.arguments) {
    const hook: ts.FunctionLikeDeclaration | null = calledFunction(checker, argument);
    if (hook !== null) roots.push(hook);
  }
  const functions: ReadonlySet<ts.Node> = collectResetFunctions(checker, roots, testFileSet);
  const spyCalls: ts.CallExpression[] = [];
  const restores: RestoreSet = emptyRestoreSet();
  const inspected: Set<ts.Node> = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (inspected.has(node)) return;
    inspected.add(node);
    if (ts.isCallExpression(node) && isInResetFunction(node, functions)) {
      if (isSpyOnCall(node)) spyCalls.push(node);
      else recordRestoreCall(checker, node, restores);
    }
    ts.forEachChild(node, visit);
  };
  for (const fn of functions) {
    if (isFunctionLikeDeclaration(fn) && fn.body !== undefined) visit(fn.body);
  }
  return { spyCalls, restores };
}

/** `collectTopLevelSpyCalls` 的参数对象。 */
interface TopLevelSpyCallsParams {
  /** TypeScript 类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** 文件 AST。 */
  readonly source: ts.SourceFile;
  /** 仓库内全部测试与测试辅助文件绝对路径集合。 */
  readonly testFileSet: ReadonlySet<string>;
}

/**
 * 收集单个文件顶层、`describe` 一级语句与 `beforeAll`/`beforeEach` 钩子函数里的 `spyOn(...)` 调用及其作用域链；
 * 同一处 `spyOn` 经多个准备钩子共用的辅助函数到达时只记第一次。
 *
 * @param params 类型检查器、文件 AST 与测试文件集合
 * @returns 套件级 `spyOn` 列表及每个子套件作用域到父套件作用域的映射
 */
function collectTopLevelSpyCalls({ checker, source, testFileSet }: TopLevelSpyCallsParams): TopLevelSpyCallsResult {
  const calls: ScopedSpyCall[] = [];
  const seenCalls: Set<ts.CallExpression> = new Set<ts.CallExpression>();
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
      const setupHook: string | undefined = lifecycleHookName(node, SETUP_HOOK_FUNCTIONS);
      if (setupHook !== undefined) {
        const origin: SpyCallOrigin = setupHook === "beforeAll" ? "beforeAll" : "beforeEach";
        const { spyCalls, restores }: HookFunctionCalls = collectHookFunctionCalls({ checker, hookCall: node, testFileSet });
        for (const call of spyCalls) {
          if (seenCalls.has(call)) continue;
          seenCalls.add(call);
          calls.push({ call, origin, scope, setupRestores: restores });
        }
        return;
      }
      if (isSpyOnCall(node)) {
        calls.push({ call: node, origin: "top-level", scope, setupRestores: undefined });
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

/** 单个套件作用域上注册的清理钩子里的还原调用，按钩子种类分开记录。 */
interface ScopeCleanupRestores {
  /** `afterAll` 钩子里的还原调用。 */
  readonly afterAll: RestoreSet;
  /** `afterEach` 钩子里的还原调用。 */
  readonly afterEach: RestoreSet;
}

/**
 * 一次遍历收集文件内各套件作用域的 `afterAll`/`afterEach` 钩子（可传递进入 `test/` 下辅助函数）里的还原调用。
 *
 * @param checker TypeScript 类型检查器
 * @param source 测试文件 AST
 * @param testFileSet 仓库内全部测试与测试辅助文件绝对路径集合
 * @returns 套件作用域到按钩子种类划分的还原记录
 */
function collectCleanupRestores(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  testFileSet: ReadonlySet<string>
): ReadonlyMap<ts.Node, ScopeCleanupRestores> {
  const restoresByScope: Map<ts.Node, ScopeCleanupRestores> = new Map();
  const visitHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hookName: string | undefined = lifecycleHookName(node, CLEANUP_HOOK_FUNCTIONS);
      if (hookName !== undefined) {
        const scope: ts.Node = enclosingSuiteScope(node, source);
        let scopeRestores: ScopeCleanupRestores | undefined = restoresByScope.get(scope);
        if (scopeRestores === undefined) {
          scopeRestores = { afterAll: emptyRestoreSet(), afterEach: emptyRestoreSet() };
          restoresByScope.set(scope, scopeRestores);
        }
        const target: RestoreSet = hookName === "afterAll" ? scopeRestores.afterAll : scopeRestores.afterEach;
        const { restores }: HookFunctionCalls = collectHookFunctionCalls({ checker, hookCall: node, testFileSet });
        target.global ||= restores.global;
        for (const symbol of restores.symbols) target.symbols.add(symbol);
      }
    }
    ts.forEachChild(node, visitHooks);
  };
  visitHooks(source);
  return restoresByScope;
}

/**
 * 收集各作用域顶层同步位置（不在任何回调内）的还原调用。
 *
 * @param checker TypeScript 类型检查器
 * @param source 测试文件 AST
 * @returns 套件作用域到顶层同步还原记录
 */
function collectSyncRestores(checker: ts.TypeChecker, source: ts.SourceFile): ReadonlyMap<ts.Node, RestoreSet> {
  const restoresByScope: Map<ts.Node, RestoreSet> = new Map();
  const visitSyncRestores = (node: ts.Node, scope: ts.Node, inFunction: boolean): void => {
    if (!inFunction && ts.isCallExpression(node) && (isGlobalMockRestoreCall(node) || isMockRestoreCall(node))) {
      let scopeRestores: RestoreSet | undefined = restoresByScope.get(scope);
      if (scopeRestores === undefined) {
        scopeRestores = emptyRestoreSet();
        restoresByScope.set(scope, scopeRestores);
      }
      recordRestoreCall(checker, node, scopeRestores);
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
  return restoresByScope;
}

/** `isRestoredByCleanup` 参数对象。 */
interface CleanupRestoreCheckParams {
  /** `spyOn` 所在的直接套件作用域。 */
  readonly scope: ts.Node;
  /** 绑定的替身变量符号（未绑定变量时为 `undefined`）。 */
  readonly symbol: ts.Symbol | undefined;
  /** 子套件作用域到父套件作用域的映射。 */
  readonly parentScopeByScope: ReadonlyMap<ts.Node, ts.Node>;
  /** 各套件作用域的清理钩子还原记录。 */
  readonly cleanupRestores: ReadonlyMap<ts.Node, ScopeCleanupRestores>;
  /** 是否同时承认 `afterEach` 里的还原（仅 `beforeEach` 创建的监听）。 */
  readonly acceptAfterEach: boolean;
}

/**
 * 判断监听是否在所属作用域或其祖先作用域的清理钩子中还原。
 *
 * @param params 作用域、绑定符号、父作用域映射、清理钩子还原记录与可接受的钩子种类
 * @returns 已在合法作用域还原时返回 true
 */
function isRestoredByCleanup({
  scope,
  symbol,
  parentScopeByScope,
  cleanupRestores,
  acceptAfterEach,
}: CleanupRestoreCheckParams): boolean {
  for (let current: ts.Node | undefined = scope; current !== undefined; current = parentScopeByScope.get(current)) {
    const restores: ScopeCleanupRestores | undefined = cleanupRestores.get(current);
    if (restoresSpy(restores?.afterAll, symbol)) return true;
    if (acceptAfterEach && restoresSpy(restores?.afterEach, symbol)) return true;
  }
  return false;
}

/**
 * 按创建位置给出未恢复监听的诊断文案。
 *
 * @param origin 监听创建位置
 * @param label 绑定变量名或 `spyOn(...)`
 * @returns 诊断文案（不含文件位置前缀）
 */
function spyRestoreProblemText(origin: SpyCallOrigin, label: string): string {
  const hooks: string = origin === "beforeEach" ? "afterEach/afterAll" : "afterAll";
  return `${origin} ${label} must be restored in ${hooks} of the same or an enclosing suite: ` +
    "call .mockRestore() when spying on a real function, or mock.restore() when the target may already be a mock " +
    "(spyOn then returns that mock and .mockRestore() clears its implementation)";
}

/**
 * 检查 `test/` 下所有测试与辅助文件里的套件级 `spyOn`（顶层、`describe` 一级语句与 `beforeAll`/`beforeEach`
 * 钩子函数）是否按创建位置在对应位置调用 `.mockRestore()`、`mock.restore()` 或 `jest.restoreAllMocks()`。
 *
 * @param params program、类型检查器与待检查文件列表
 * @returns 未按规恢复套件级 `spyOn` 的问题列表
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
    const { calls, parentScopeByScope }: TopLevelSpyCallsResult = collectTopLevelSpyCalls({ checker, source, testFileSet });
    if (calls.length === 0) continue;
    const cleanupRestores: ReadonlyMap<ts.Node, ScopeCleanupRestores> = collectCleanupRestores(checker, source, testFileSet);
    let syncRestores: ReadonlyMap<ts.Node, RestoreSet> | undefined;
    for (const { call, origin, scope, setupRestores } of calls) {
      const symbol: ts.Symbol | undefined = boundSpySymbol(checker, call);
      if (restoresSpy(setupRestores, symbol)) continue;
      if (origin === "top-level") {
        syncRestores ??= collectSyncRestores(checker, source);
        if (restoresSpy(syncRestores.get(scope), symbol)) continue;
      }
      if (isRestoredByCleanup({
        scope,
        symbol,
        parentScopeByScope,
        cleanupRestores,
        acceptAfterEach: origin === "beforeEach",
      })) continue;
      const callSource: ts.SourceFile = call.getSourceFile();
      const { line, character }: ts.LineAndCharacter =
        callSource.getLineAndCharacterOfPosition(call.getStart(callSource));
      const label: string = symbol === undefined ? "spyOn(...)" : symbol.name;
      problems.push(`${relative(projectRoot, callSource.fileName)}:${line + 1}:${character + 1}: ${spyRestoreProblemText(origin, label)}`);
    }
  }
  return problems;
}
