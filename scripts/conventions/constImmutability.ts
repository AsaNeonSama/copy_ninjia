import { relative } from "node:path";
import ts from "typescript";
import type { ExportedConstDeclaration } from "./constsProgram";

/** collectConstImmutabilityAssertionProblems 的入参。 */
export interface ConstImmutabilityParams {
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 以 `packages/consts/` 与 `packages/mini-app-frontend/consts/` 为入口经 createTypeCheckProgram 建的 program 的类型检查器。 */
  readonly checker: ts.TypeChecker;
  /** `packages/consts/` 与 `packages/mini-app-frontend/consts/` 的全部导出常量声明（exportedConstDeclarations）。 */
  readonly declarations: readonly ExportedConstDeclaration[];
  /** test/consts/immutability.test.ts 的全文。 */
  readonly assertionSource: string;
}

/**
 * 判断类型是否为未加 `Readonly<...>` 包装的可变 `RegExp`（其 `lastIndex` 可被调用方改写）。
 *
 * @param type 待判断的 TypeScript 类型
 * @returns 类型本身为可变 `RegExp` 时返回 true
 */
function isMutableRegExp(type: ts.Type): boolean {
  return type.getSymbol()?.getName() === "RegExp";
}

/**
 * 判断类型是否为经 `Readonly<RegExp>` 包装的只读正则类型。
 *
 * @param type 待判断的 TypeScript 类型
 * @returns 类型为 `Readonly<RegExp>` 时返回 true
 */
function isReadonlyRegExp(type: ts.Type): boolean {
  return type.aliasSymbol?.getName() === "Readonly" &&
    type.aliasTypeArguments?.length === 1 &&
    type.aliasTypeArguments[0]?.getSymbol()?.getName() === "RegExp";
}

/**
 * 判断类型是否为 `RegExp` 或 `Readonly<RegExp>`。
 *
 * @param type 待判断的 TypeScript 类型
 * @returns 为正则类型时返回 true
 */
function isRegExpType(type: ts.Type): boolean {
  return isMutableRegExp(type) || isReadonlyRegExp(type);
}

/**
 * 字符串、数字、布尔、null、undefined、函数值与正则不算对象元素
 * （正则常量及容器内正则元素由本门禁直接通过类型检查器强制要求声明为 `Readonly<RegExp>`，
 * 无需逐条在 `test/consts/immutability.test.ts` 中手写 `.lastIndex` 断言）。
 *
 * @param type 待判断的 TypeScript 类型
 * @returns 为需要不可变断言的对象类型时返回 true
 */
function isObjectLike(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isObjectLike);
  if (isRegExpType(type)) return false;
  const primitiveFlags: number = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
    | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  if ((type.flags & primitiveFlags) !== 0) return false;
  if (type.getCallSignatures().length > 0) return false;
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

/**
 * 递归检查导出常量类型自身及其容器/属性元素中是否暴露了可变 `RegExp`。
 *
 * @param checker TypeScript 类型检查器
 * @param type 待检查的 TypeScript 类型
 * @param visited 已遍历类型集合（防循环引用）
 * @returns 暴露了未标注为 `Readonly<RegExp>` 的正则时返回 true
 */
function hasMutableRegExp(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited: Set<ts.Type> = new Set<ts.Type>()
): boolean {
  if (visited.has(type)) return false;
  visited.add(type);
  if (isMutableRegExp(type)) return true;
  if (isReadonlyRegExp(type)) return false;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member: ts.Type): boolean => hasMutableRegExp(checker, member, visited));
  }
  if (type.getCallSignatures().length > 0) return false;
  return elementTypes(checker, type).some(
    (element: ts.Type): boolean => hasMutableRegExp(checker, element, visited)
  );
}

/**
 * 容器的元素类型：数组/元组的元素、Map 的值、Set 的元素，普通对象的索引签名值与属性值。
 *
 * @param checker TypeScript 类型检查器
 * @param type 容器的 TypeScript 类型
 * @returns 容器包含的元素或属性类型列表
 */
function elementTypes(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return [...checker.getTypeArguments(type as ts.TypeReference)];
  }
  const symbolName: string | undefined = type.getSymbol()?.getName();
  if (symbolName === "Map" || symbolName === "ReadonlyMap") {
    const value: ts.Type | undefined = checker.getTypeArguments(type as ts.TypeReference)[1];
    return value === undefined ? [] : [value];
  }
  if (symbolName === "Set" || symbolName === "ReadonlySet") {
    const element: ts.Type | undefined = checker.getTypeArguments(type as ts.TypeReference)[0];
    return element === undefined ? [] : [element];
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const indexValues: ts.Type[] = checker.getIndexInfosOfType(type).map((info: ts.IndexInfo): ts.Type => info.type);
  if (indexValues.length > 0) return indexValues;
  return checker.getPropertiesOfType(type).map((property: ts.Symbol): ts.Type => checker.getTypeOfSymbol(property));
}

/**
 * 第 index 行正上方连续的 `//` 注释行里有没有 `@ts-expect-error`（多行说明的首行带指令）。
 *
 * @param lines 断言文件按行切分后的文本列表
 * @param index 待检查代码行的 0-based 行号
 * @returns 正上方连续单行注释中包含 `@ts-expect-error` 时返回 true
 */
function followsExpectError(lines: readonly string[], index: number): boolean {
  for (let line: number = index - 1; line >= 0; line--) {
    const text: string = lines[line]!.trim();
    if (!text.startsWith("//")) return false;
    if (text.includes("@ts-expect-error")) return true;
  }
  return false;
}

/**
 * 校验导出常量的编译期不可变性：
 * 1. 任何导出正则常量或容器/属性中暴露的 `RegExp` 必须声明为 `Readonly<RegExp>`；
 * 2. 带对象元素的导出常量表必须在 `test/consts/immutability.test.ts` 里有 `@ts-expect-error` 改写断言
 *    （按 `NAME.` 或 `NAME[` 访问且紧跟在带 `@ts-expect-error` 的注释之后）。
 *
 * @param params 常量不可变断言检查入参
 * @returns 可变正则或缺少不可变断言的违规信息列表
 */
export function collectConstImmutabilityAssertionProblems({
  projectRoot,
  checker,
  declarations,
  assertionSource,
}: ConstImmutabilityParams): string[] {
  const lines: readonly string[] = assertionSource.split("\n");
  const problems: string[] = [];
  for (const { path, name, declaration } of declarations) {
    const type: ts.Type = checker.getTypeAtLocation(declaration.name);
    if (hasMutableRegExp(checker, type)) {
      problems.push(
        `${relative(projectRoot, path)}: ${name} exposes a mutable RegExp; annotate it as Readonly<RegExp>`
      );
    }
    if (isRegExpType(type)) continue;
    if (!elementTypes(checker, type).some(isObjectLike)) continue;
    const access: RegExp = new RegExp(`\\b${name}[.[]`);
    if (lines.some((line: string, index: number): boolean => access.test(line) && followsExpectError(lines, index))) continue;
    problems.push(
      `${relative(projectRoot, path)}: ${name} holds object elements; add a @ts-expect-error immutability ` +
      "assertion to test/consts/immutability.test.ts"
    );
  }
  return problems;
}
