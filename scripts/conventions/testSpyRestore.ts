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
 * 套件级 `spyOn` 恢复门禁：模块顶层、`describe` 一级语句以及 `beforeAll`/`beforeEach` 回调里创建的
 * `spyOn` 必须在同一作用域或祖先作用域的清理钩子里调用 `.mockRestore()` 或 `mock.restore()`（等价的 `jest.restoreAllMocks()`）还原，
 * 避免在 `bun test --randomize` 下污染后续测试套件：
 * - 顶层与 `beforeAll` 创建的监听只认 `afterAll`（`afterEach` 会在第一个用例后就撤掉监听）；
 *   顶层监听另认同作用域顶层同步位置的还原。
 * - `beforeEach` 创建的监听认 `afterEach` 或 `afterAll`。
 * 被监听目标已是 mock 时，Bun 的 `spyOn` 返回同一个 mock，对它调用 `.mockRestore()` 会清空实现，
 * 这类目标应改用 `mock.restore()`；门禁无法静态区分目标，诊断文案同时给出两种写法。
 */

/** 只在套件全部用例结束后运行的清理钩子。 */
const AFTER_ALL_HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["afterAll"]);

/** 每个用例结束后或套件结束后运行的清理钩子。 */
const AFTER_ANY_HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["afterEach", "afterAll"]);

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

/** 套件级 `spyOn(...)` 调用及其所属套件作用域。 */
interface ScopedSpyCall {
  /** `spyOn(...)` 调用表达式。 */
  readonly call: ts.CallExpression;
  /** 调用所在的创建位置。 */
  readonly origin: SpyCallOrigin;
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
  const receiverName: string = expectedGlobalRestoreReceiver(callee.name.text);
  if (receiverName.length === 0) return false;
  const receiver: ts.Expression = unwrapExpression(callee.expression);
  if (ts.isIdentifier(receiver)) return receiver.text === receiverName;
  return ts.isPropertyAccessExpression(receiver) && receiver.name.text === receiverName;
}

/**
 * 全局还原方法名对应的接收者名：`restore` 属于 `mock`，`restoreAllMocks` 属于 `jest`。
 *
 * @param methodName 调用的方法名
 * @returns 对应的接收者名；不是全局还原方法时返回空字符串
 */
function expectedGlobalRestoreReceiver(methodName: string): string {
  if (methodName === "restore") return "mock";
  if (methodName === "restoreAllMocks") return "jest";
  return "";
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
 * 收集 `node` 子树内全部 `spyOn(...)` 调用（含嵌套回调），记作给定创建位置的套件级监听。
 *
 * @param node 准备钩子回调的函数体
 * @param push 记录一条监听调用的回调
 */
function collectSpyCallsWithin(node: ts.Node, push: (call: ts.CallExpression) => void): void {
  if (ts.isCallExpression(node) && isSpyOnCall(node)) push(node);
  ts.forEachChild(node, (child: ts.Node): void => {
    collectSpyCallsWithin(child, push);
  });
}

/**
 * 收集单个文件顶层、`describe` 一级语句与 `beforeAll`/`beforeEach` 回调里的 `spyOn(...)` 调用及其作用域链。
 *
 * @param source 文件 AST
 * @returns 套件级 `spyOn` 列表及每个子套件作用域到父套件作用域的映射
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
      const setupHook: string | undefined = lifecycleHookName(node, SETUP_HOOK_FUNCTIONS);
      if (setupHook !== undefined) {
        const origin: SpyCallOrigin = setupHook === "beforeAll" ? "beforeAll" : "beforeEach";
        for (const argument of node.arguments) {
          const target: ts.Expression = unwrapExpression(argument);
          if ((ts.isArrowFunction(target) || ts.isFunctionExpression(target)) && target.body !== undefined) {
            collectSpyCallsWithin(target.body, (call: ts.CallExpression): void => {
              calls.push({ call, origin, scope });
            });
          }
        }
        return;
      }
      if (isSpyOnCall(node)) {
        calls.push({ call: node, origin: "top-level", scope });
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

/** 按作用域汇总的清理钩子内 `.mockRestore()` 与全局 `mock.restore()` 恢复记录。 */
interface HookRestoreRecords {
  /** 各作用域内经清理钩子恢复的绑定符号集合。 */
  readonly symbolsByScope: ReadonlyMap<ts.Node, ReadonlySet<ts.Symbol>>;
  /** 注册了包含 `mock.restore()` 的清理钩子的作用域集合。 */
  readonly globalScopes: ReadonlySet<ts.Node>;
}

/** 按作用域汇总的顶层同步位置 `.mockRestore()` 与全局 `mock.restore()` 恢复记录。 */
interface SyncRestoreRecords {
  /** 在对应作用域顶层同步调用 `.mockRestore()` 的符号集合。 */
  readonly symbolsByScope: ReadonlyMap<ts.Node, ReadonlySet<ts.Symbol>>;
  /** 在对应作用域顶层同步调用 `mock.restore()` 的作用域集合。 */
  readonly globalScopes: ReadonlySet<ts.Node>;
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

/** `collectHookRestoreRecords` 的参数对象。 */
interface HookRestoreRecordParams {
  /** TypeScript 类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** 测试文件 AST。 */
  readonly source: ts.SourceFile;
  /** 仓库内全部测试与测试辅助文件绝对路径集合。 */
  readonly testFileSet: ReadonlySet<string>;
  /** 计入恢复的清理钩子名集合。 */
  readonly hookNames: ReadonlySet<string>;
}

/**
 * 收集同一个测试文件内分作用域记录、在指定清理钩子（可传递进入 `test/` 下辅助函数）里对
 * `.mockRestore()` / `mock.restore()` 的调用。
 *
 * @param params 类型检查器、文件 AST、测试文件集合与清理钩子名集合
 * @returns 分作用域的清理钩子恢复记录
 */
function collectHookRestoreRecords({
  checker,
  source,
  testFileSet,
  hookNames,
}: HookRestoreRecordParams): HookRestoreRecords {
  const hookRootsByScope: Map<ts.Node, ts.FunctionLikeDeclaration[]> = new Map();
  const visitHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && lifecycleHookName(node, hookNames) !== undefined) {
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

  const symbolsByScope: Map<ts.Node, Set<ts.Symbol>> = new Map();
  const globalScopes: Set<ts.Node> = new Set();
  for (const [scope, roots] of hookRootsByScope) {
    const cleanupFunctions: ReadonlySet<ts.Node> = collectResetFunctions(checker, roots, testFileSet);
    const inspectedNodes: Set<ts.Node> = new Set();
    for (const fn of cleanupFunctions) {
      const visitFn = (node: ts.Node): void => {
        if (inspectedNodes.has(node)) return;
        inspectedNodes.add(node);
        if (ts.isCallExpression(node) && isInResetFunction(node, cleanupFunctions)) {
          if (isGlobalMockRestoreCall(node)) {
            globalScopes.add(scope);
          } else if (isMockRestoreCall(node)) {
            for (const symbol of mockSymbols(checker, node.expression.expression)) {
              addScopedSymbol(symbolsByScope, scope, symbol);
            }
          }
        }
        ts.forEachChild(node, visitFn);
      };
      if (isFunctionLikeDeclaration(fn) && fn.body !== undefined) visitFn(fn.body);
    }
  }
  return { symbolsByScope, globalScopes };
}

/**
 * 收集各作用域顶层同步位置（不在任何回调内）对 `.mockRestore()` / `mock.restore()` 的调用。
 *
 * @param checker TypeScript 类型检查器
 * @param source 测试文件 AST
 * @returns 分作用域的顶层同步恢复记录
 */
function collectSyncRestoreRecords(checker: ts.TypeChecker, source: ts.SourceFile): SyncRestoreRecords {
  const symbolsByScope: Map<ts.Node, Set<ts.Symbol>> = new Map();
  const globalScopes: Set<ts.Node> = new Set();
  const visitSyncRestores = (node: ts.Node, scope: ts.Node, inFunction: boolean): void => {
    if (!inFunction && ts.isCallExpression(node)) {
      if (isGlobalMockRestoreCall(node)) {
        globalScopes.add(scope);
      } else if (isMockRestoreCall(node)) {
        for (const symbol of mockSymbols(checker, node.expression.expression)) {
          addScopedSymbol(symbolsByScope, scope, symbol);
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
  return { symbolsByScope, globalScopes };
}

/** `isSpyRestoredInCoveringScope` 参数对象。 */
interface SpyRestoreScopeCheckParams {
  /** `spyOn` 所在的直接套件作用域。 */
  readonly scope: ts.Node;
  /** 绑定的替身变量符号（未绑定变量时为 `undefined`）。 */
  readonly symbol: ts.Symbol | undefined;
  /** 子套件作用域到父套件作用域的映射。 */
  readonly parentScopeByScope: ReadonlyMap<ts.Node, ts.Node>;
  /** 按监听创建位置选定的清理钩子恢复记录。 */
  readonly hooks: HookRestoreRecords;
  /** 顶层同步恢复记录；只对顶层创建的监听生效，其余创建位置传 undefined。 */
  readonly sync: SyncRestoreRecords | undefined;
}

/**
 * 判断某套件级 `spyOn` 调用是否在所属作用域或其祖先作用域的清理钩子中（顶层监听另可在同作用域顶层同步位置）恢复。
 *
 * @param params 作用域、绑定符号、父作用域映射与恢复记录
 * @returns 已在合法作用域调用恢复时返回 true
 */
function isSpyRestoredInCoveringScope({
  scope,
  symbol,
  parentScopeByScope,
  hooks,
  sync,
}: SpyRestoreScopeCheckParams): boolean {
  if (sync !== undefined) {
    if (sync.globalScopes.has(scope)) return true;
    if (symbol !== undefined && sync.symbolsByScope.get(scope)?.has(symbol) === true) return true;
  }
  let current: ts.Node | undefined = scope;
  while (current !== undefined) {
    if (hooks.globalScopes.has(current)) return true;
    if (symbol !== undefined && hooks.symbolsByScope.get(current)?.has(symbol) === true) {
      return true;
    }
    current = parentScopeByScope.get(current);
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
  const where: string = origin === "top-level" ? "top-level" : `${origin}`;
  const hooks: string = origin === "beforeEach" ? "afterEach/afterAll" : "afterAll";
  return `${where} ${label} must be restored in ${hooks} of the same or an enclosing suite: ` +
    "call .mockRestore() when spying on a real function, or mock.restore() when the target may already be a mock " +
    "(spyOn then returns that mock and .mockRestore() clears its implementation)";
}

/**
 * 检查 `test/` 下所有测试与辅助文件里的套件级 `spyOn`（顶层、`describe` 一级语句与 `beforeAll`/`beforeEach`
 * 回调）是否在所属或外层作用域的对应清理钩子（顶层监听另可在同作用域顶层同步位置）调用
 * `.mockRestore()` 或 `mock.restore()`。
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
    const { calls, parentScopeByScope }: TopLevelSpyCallsResult = collectTopLevelSpyCalls(source);
    if (calls.length === 0) continue;
    const afterAllHooks: HookRestoreRecords = collectHookRestoreRecords({
      checker, source, testFileSet, hookNames: AFTER_ALL_HOOK_FUNCTIONS,
    });
    let afterAnyHooks: HookRestoreRecords | undefined;
    let sync: SyncRestoreRecords | undefined;
    for (const { call, origin, scope } of calls) {
      const symbol: ts.Symbol | undefined = boundSpySymbol(checker, call);
      let hooks: HookRestoreRecords = afterAllHooks;
      if (origin === "beforeEach") {
        afterAnyHooks ??= collectHookRestoreRecords({
          checker, source, testFileSet, hookNames: AFTER_ANY_HOOK_FUNCTIONS,
        });
        hooks = afterAnyHooks;
      }
      if (origin === "top-level") sync ??= collectSyncRestoreRecords(checker, source);
      if (isSpyRestoredInCoveringScope({
        scope,
        symbol,
        parentScopeByScope,
        hooks,
        sync: origin === "top-level" ? sync : undefined,
      })) continue;
      const { line, character }: ts.LineAndCharacter =
        source.getLineAndCharacterOfPosition(call.getStart(source));
      const label: string = symbol === undefined ? "spyOn(...)" : symbol.name;
      problems.push(`${relative(projectRoot, path)}:${line + 1}:${character + 1}: ${spyRestoreProblemText(origin, label)}`);
    }
  }
  return problems;
}
