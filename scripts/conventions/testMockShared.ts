import ts from "typescript";
import { unwrapExpression } from "./staticAccess";

/**
 * 测试替身复位（`testMockReset.ts`）与套件级 `spyOn` 还原（`testSpyRestore.ts`）共用的
 * TypeScript AST 与符号解析叶子工具模块。
 */

/** `describe` 套件节点名集合，回调内部的一级语句仍视为顶层套件作用域。 */
const SUITE_FUNCTIONS: ReadonlySet<string> = new Set(["describe"]);

/**
 * `await import("x")` 解构出的绑定解析到模块 `x` 的同名导出；其它绑定原样返回。
 *
 * @param checker TypeScript 类型检查器
 * @param symbol 待解析的符号
 * @returns 解析到的被导入模块导出符号或原符号
 */
function resolveImportBinding(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const declaration: ts.Declaration | undefined = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isBindingElement(declaration) ||
    !ts.isObjectBindingPattern(declaration.parent) ||
    !ts.isVariableDeclaration(declaration.parent.parent)
  ) {
    return symbol;
  }
  const initializer: ts.Expression | undefined = declaration.parent.parent.initializer;
  if (initializer === undefined) return symbol;
  let call: ts.Expression = unwrapExpression(initializer);
  if (ts.isAwaitExpression(call)) call = unwrapExpression(call.expression);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return symbol;
  const specifier: ts.Expression | undefined = call.arguments[0];
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return symbol;
  const moduleSymbol: ts.Symbol | undefined = checker.getSymbolAtLocation(specifier);
  if (moduleSymbol === undefined) return symbol;
  const prop: ts.PropertyName | ts.BindingName = declaration.propertyName ?? declaration.name;
  const name: string = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : prop.getText();
  const exported: ts.Symbol | undefined = checker
    .getExportsOfModule(moduleSymbol)
    .find((candidate: ts.Symbol): boolean => candidate.name === name);
  return exported === undefined ? symbol : canonicalSymbol(checker, exported);
}

/**
 * 沿 import 别名与 `await import()` 解构走到声明符号。
 *
 * @param checker TypeScript 类型检查器
 * @param symbol 待归一化的符号
 * @returns 源声明符号
 */
function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const target: ts.Symbol = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return resolveImportBinding(checker, target);
}

/**
 * 标识符或属性访问的名字节点上的符号；其它表达式返回 undefined。
 *
 * @param checker TypeScript 类型检查器
 * @param expression 待检查的表达式节点
 * @returns 关联的 TypeScript 符号，无法解析时返回 undefined
 */
function referencedSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  const target: ts.Expression = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return checker.getSymbolAtLocation(target);
  if (ts.isPropertyAccessExpression(target)) return checker.getSymbolAtLocation(target.name);
  return undefined;
}

/**
 * `for (const x of [a, b])` 的循环变量对应的数组元素；不是这种形态时返回 null。
 *
 * @param symbol 待检查的循环变量符号
 * @returns 数组字面量元素列表，非此类循环变量时返回 null
 */
function forOfArrayElements(symbol: ts.Symbol): readonly ts.Expression[] | null {
  const declaration: ts.Declaration | undefined = symbol.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;
  const list: ts.Node = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !ts.isForOfStatement(list.parent)) return null;
  const iterated: ts.Expression = unwrapExpression(list.parent.expression);
  return ts.isArrayLiteralExpression(iterated) ? iterated.elements : null;
}

/**
 * 把替身表达式解析到声明符号；解析不到时返回空数组。
 *
 * @param checker TypeScript 类型检查器
 * @param expression 替身接收者表达式
 * @returns 归一化后的声明符号列表
 */
export function mockSymbols(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol[] {
  const symbol: ts.Symbol | undefined = referencedSymbol(checker, expression);
  if (symbol === undefined) return [];
  const elements: readonly ts.Expression[] | null = forOfArrayElements(symbol);
  if (elements !== null) {
    return elements.flatMap((element: ts.Expression): ts.Symbol[] => mockSymbols(checker, element));
  }
  return [canonicalSymbol(checker, symbol)];
}

/**
 * 被调用表达式指向的、带函数体的函数声明或 `const f = () => {}` 初始化器。
 *
 * @param checker TypeScript 类型检查器
 * @param callee 被调用方表达式
 * @returns 解析到的函数声明节点，未找到时返回 null
 */
export function calledFunction(checker: ts.TypeChecker, callee: ts.Expression): ts.FunctionLikeDeclaration | null {
  const target: ts.Expression = unwrapExpression(callee);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
  const symbol: ts.Symbol | undefined = referencedSymbol(checker, target);
  if (symbol === undefined) return null;
  const declaration: ts.Declaration | undefined = canonicalSymbol(checker, symbol).valueDeclaration;
  if (declaration === undefined) return null;
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    return declaration.body === undefined ? null : declaration;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    const initializer: ts.Expression = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
  }
  return null;
}

/**
 * 钩子回调与从中可传递调用到的测试侧函数；生产代码里没有替身复位，不往里走。
 *
 * @param checker TypeScript 类型检查器
 * @param hookRoots 生命周期钩子根函数列表
 * @param testFiles 测试文件绝对路径集合
 * @returns 所有可达复位函数节点的只读集合
 */
export function collectResetFunctions(
  checker: ts.TypeChecker,
  hookRoots: readonly ts.FunctionLikeDeclaration[],
  testFiles: ReadonlySet<string>
): ReadonlySet<ts.Node> {
  const reached: Set<ts.Node> = new Set(hookRoots);
  const queue: ts.FunctionLikeDeclaration[] = [...hookRoots];
  // 遍历途中新找到的函数追加到 queue 末尾，for...of 会继续走到它们。
  for (const current of queue) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const target: ts.FunctionLikeDeclaration | null = calledFunction(checker, node.expression);
        if (target !== null && !reached.has(target) && testFiles.has(target.getSourceFile().fileName)) {
          reached.add(target);
          queue.push(target);
        }
      }
      ts.forEachChild(node, visit);
    };
    const body: ts.Node | undefined = current.body;
    if (body !== undefined) visit(body);
  }
  return reached;
}

/**
 * 节点是否位于复位钩子或其调用到的函数里。
 *
 * @param node 待检查的 AST 节点
 * @param resetFunctions 复位函数节点集合
 * @returns 位于复位函数内部时返回 true
 */
export function isInResetFunction(node: ts.Node, resetFunctions: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (resetFunctions.has(current)) return true;
  }
  return false;
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
export function isDescribeCall(call: ts.CallExpression): boolean {
  return isDescribeCallee(call.expression);
}

/**
 * 取生命周期钩子调用（`afterAll(...)`、`<ns>.beforeEach(...)` 等）的钩子名。
 *
 * @param call 调用表达式节点
 * @param hookNames 允许匹配的钩子名集合
 * @returns 命中集合时返回钩子名，否则返回 undefined
 */
export function lifecycleHookName(call: ts.CallExpression, hookNames: ReadonlySet<string>): string | undefined {
  const callee: ts.Expression = unwrapExpression(call.expression);
  const name: string | undefined = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name !== undefined && hookNames.has(name) ? name : undefined;
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
export function describeCallbackParent(node: ts.FunctionLikeDeclaration): ts.CallExpression | undefined {
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
export function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return true;
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return true;
  return ts.isConstructorDeclaration(node);
}

/**
 * 返回节点所在的直接套件作用域（所属 `describe` 调用或文件根节点 `SourceFile`）。
 *
 * @param node 待查询的 AST 节点
 * @param source 文件根 AST 节点
 * @returns 所属套件作用域节点
 */
export function enclosingSuiteScope(node: ts.Node, source: ts.SourceFile): ts.Node {
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
export function boundSpySymbol(checker: ts.TypeChecker, spyCall: ts.CallExpression): ts.Symbol | undefined {
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
