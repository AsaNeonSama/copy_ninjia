import { relative } from "node:path";
import ts from "typescript";
import {
  calledFunction,
  collectResetFunctions,
  isInResetFunction,
  mockSymbols,
} from "./testMockShared";
import { collectTopLevelSpyRestoreProblems } from "./testSpyRestore";

/**
 * 测试替身复位口径：`mockClear()` 只清调用记录，不清 `*Once` 排队的返回值或实现，残留的
 * Once 会在随机顺序下串进下一条用例。同一个替身只要排过 Once，复位钩子就必须用
 * `mockReset()` 再装回默认实现。
 *
 * - 复位钩子：`beforeEach`/`afterEach`/`beforeAll`/`afterAll` 的回调，以及从这些回调里
 *   调用到的函数（跨文件、可传递）。用例中途只为清调用记录的 `mockClear()` 不在判定范围内。
 * - 替身按 TypeScript checker 解析到声明符号（见 `scripts/conventions/testMockShared.ts`）：
 *   静态 import 与 `await import()` 解构都解析到被导入模块的导出，属性访问解析到属性声明，
 *   `for (const x of [a, b]) x.mockClear()` 归到数组里的每个元素。解析不到符号的接收者
 *   （调用结果、下标访问）不参与判定。
 * - 同一符号既出现 {@link ONCE_METHODS} 调用、又在复位钩子里出现 `mockClear()` 即报错，
 *   报错写出两处位置。
 * - 顶层 `spyOn` 恢复规则由 `scripts/conventions/testSpyRestore.ts` 的
 *   {@link collectTopLevelSpyRestoreProblems} 负责并在 {@link collectMockResetProblems} 内统一汇总。
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
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 包含测试文件的 TypeScript Program。 */
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

/**
 * 列出同一替身既排过 Once、又在复位钩子里只用 mockClear 复位的符号，并汇总文件顶层 `spyOn` 恢复检查。
 *
 * @param params 测试替身复位检查入参
 * @returns 违规替身复位问题列表
 */
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
  problems.push(...collectTopLevelSpyRestoreProblems({ projectRoot, program, checker, testFiles }));
  return problems.sort();
}
