import { relative } from "node:path";
import ts from "typescript";

/**
 * 测试替身复位口径：`mockClear()` 只清调用记录，不清 `*Once` 排队的返回值或实现，残留的
 * Once 会在随机顺序下串进下一条用例。同一个替身只要排过 Once，复位钩子就必须用
 * `mockReset()` 再装回默认实现。
 *
 * - 复位钩子：`beforeEach`/`afterEach`/`beforeAll`/`afterAll` 的回调，以及从这些回调里
 *   调用到的函数（跨文件、可传递）。用例中途只为清调用记录的 `mockClear()` 不在判定范围内。
 * - 替身按 TypeScript checker 解析到声明符号：静态 import 与 `await import()` 解构都解析到
 *   被导入模块的导出，属性访问解析到属性声明，`for (const x of [a, b]) x.mockClear()`
 *   归到数组里的每个元素。解析不到符号的接收者（调用结果、下标访问）不参与判定。
 * - 同一符号既出现 {@link ONCE_METHODS} 调用、又在复位钩子里出现 `mockClear()` 即报错，
 *   报错写出两处位置。
 */

/** 会排队一次性返回值或实现的替身方法。 */
const ONCE_METHODS: ReadonlySet<string> = new Set([
  "mockReturnValueOnce",
  "mockResolvedValueOnce",
  "mockRejectedValueOnce",
  "mockImplementationOnce",
]);

/** bun:test 的生命周期钩子。 */
const HOOK_FUNCTIONS: ReadonlySet<string> = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);

/** 门禁入参：覆盖全部测试文件的 program 与其中要检查的文件。 */
export interface MockResetRuleParams {
  readonly projectRoot: string;
  readonly program: ts.Program;
  /** 被检查测试文件的绝对路径。 */
  readonly testFiles: readonly string[];
}

/** 一处替身调用：接收者解析出的符号与源码位置。 */
interface MockCall {
  readonly node: ts.CallExpression;
  readonly symbols: readonly ts.Symbol[];
  readonly position: string;
}

/** 去掉括号、`as`、非空断言与 `satisfies` 外壳。 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current: ts.Expression = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `await import("x")` 解构出的绑定解析到模块 `x` 的同名导出；其它绑定原样返回。 */
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
  const name: string = (declaration.propertyName ?? declaration.name).getText();
  const exported: ts.Symbol | undefined = checker
    .getExportsOfModule(moduleSymbol)
    .find((candidate: ts.Symbol): boolean => candidate.name === name);
  return exported === undefined ? symbol : canonicalSymbol(checker, exported);
}

/** 沿 import 别名与 `await import()` 解构走到声明符号。 */
function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const target: ts.Symbol = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return resolveImportBinding(checker, target);
}

/** 标识符或属性访问的名字节点上的符号；其它表达式返回 undefined。 */
function referencedSymbol(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol | undefined {
  const target: ts.Expression = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return checker.getSymbolAtLocation(target);
  if (ts.isPropertyAccessExpression(target)) return checker.getSymbolAtLocation(target.name);
  return undefined;
}

/** `for (const x of [a, b])` 的循环变量对应的数组元素；不是这种形态时返回 null。 */
function forOfArrayElements(symbol: ts.Symbol): readonly ts.Expression[] | null {
  const declaration: ts.Declaration | undefined = symbol.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;
  const list: ts.Node = declaration.parent;
  if (!ts.isVariableDeclarationList(list) || !ts.isForOfStatement(list.parent)) return null;
  const iterated: ts.Expression = unwrapExpression(list.parent.expression);
  return ts.isArrayLiteralExpression(iterated) ? iterated.elements : null;
}

/** 把替身表达式解析到声明符号；解析不到时返回空数组。 */
function mockSymbols(checker: ts.TypeChecker, expression: ts.Expression): ts.Symbol[] {
  const symbol: ts.Symbol | undefined = referencedSymbol(checker, expression);
  if (symbol === undefined) return [];
  const elements: readonly ts.Expression[] | null = forOfArrayElements(symbol);
  if (elements !== null) {
    return elements.flatMap((element: ts.Expression): ts.Symbol[] => mockSymbols(checker, element));
  }
  return [canonicalSymbol(checker, symbol)];
}

/** 被调用表达式指向的、带函数体的函数声明或 `const f = () => {}` 初始化器。 */
function calledFunction(checker: ts.TypeChecker, callee: ts.Expression): ts.FunctionLikeDeclaration | null {
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

/** 钩子回调与从中可传递调用到的测试侧函数；生产代码里没有替身复位，不往里走。 */
function collectResetFunctions(
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

/** 节点是否位于复位钩子或其调用到的函数里。 */
function isInResetFunction(node: ts.Node, resetFunctions: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (resetFunctions.has(current)) return true;
  }
  return false;
}

/** 列出同一替身既排过 Once、又在复位钩子里只用 mockClear 复位的符号。 */
export function collectMockResetProblems({ projectRoot, program, testFiles }: MockResetRuleParams): string[] {
  const checker: ts.TypeChecker = program.getTypeChecker();
  const hookRoots: ts.FunctionLikeDeclaration[] = [];
  const onceCalls: MockCall[] = [];
  const clearCalls: MockCall[] = [];
  for (const path of testFiles) {
    const source: ts.SourceFile | undefined = program.getSourceFile(path);
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && HOOK_FUNCTIONS.has(node.expression.text)) {
          for (const argument of node.arguments) {
            const hook: ts.FunctionLikeDeclaration | null = calledFunction(checker, argument);
            if (hook !== null) hookRoots.push(hook);
          }
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const method: string = node.expression.name.text;
          const isOnce: boolean = ONCE_METHODS.has(method);
          if (isOnce || (method === "mockClear" && node.arguments.length === 0)) {
            const { line, character }: ts.LineAndCharacter = source.getLineAndCharacterOfPosition(node.getStart(source));
            const call: MockCall = {
              node,
              symbols: mockSymbols(checker, node.expression.expression),
              position: `${relative(projectRoot, path)}:${line + 1}:${character + 1}`,
            };
            (isOnce ? onceCalls : clearCalls).push(call);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const firstOnce: Map<ts.Symbol, string> = new Map();
  for (const call of onceCalls) {
    for (const symbol of call.symbols) {
      if (!firstOnce.has(symbol)) firstOnce.set(symbol, call.position);
    }
  }
  const resetFunctions: ReadonlySet<ts.Node> = collectResetFunctions(checker, hookRoots, new Set(testFiles));
  const problems: string[] = [];
  for (const call of clearCalls) {
    if (!isInResetFunction(call.node, resetFunctions)) continue;
    for (const symbol of call.symbols) {
      const once: string | undefined = firstOnce.get(symbol);
      if (once === undefined) continue;
      problems.push(
        `${call.position}: ${symbol.name} is reset with mockClear() but queues *Once values ` +
        `(${once}); reset it with mockReset() and reinstall its default implementation`
      );
    }
  }
  return problems.sort();
}
