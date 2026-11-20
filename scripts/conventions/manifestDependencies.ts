import { join, relative } from "node:path";
import type ts from "typescript";
import { isRuntimeBuiltinModule } from "./nodeCompatibility";
import { runtimeModuleReferences } from "./sourceAnalysis";

/**
 * 项目源码的运行期裸导入必须由根 `package.json` 直接声明。
 *
 * 只经传递依赖提升到 `node_modules/` 顶层的包（phantom dependency）不算声明；
 * 本模块按 AST 取运行期引用，纯类型引用、相对路径、Bun 与 Node 内建模块不参与判定，
 * 包子路径归到所属包名。
 */

interface RootPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** 根 `package.json` 直接声明的依赖包名视图。 */
export interface DeclaredPackages {
  /** 仅包含 `dependencies` 的生产运行期包名集合。 */
  readonly runtime: ReadonlySet<string>;
  /** 包含 `dependencies` 与 `devDependencies` 的全部已声明包名集合。 */
  readonly all: ReadonlySet<string>;
}

/**
 * 读取根 manifest 直接声明的包名，区分运行期依赖（`dependencies`）与全量依赖（`dependencies` + `devDependencies`）。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @returns 运行期与全量已声明包名的只读集合对象
 */
export async function readDeclaredPackages(projectRoot: string): Promise<DeclaredPackages> {
  const manifest: RootPackageManifest = await Bun.file(join(projectRoot, "package.json")).json() as RootPackageManifest;
  const runtime: ReadonlySet<string> = new Set<string>(Object.keys(manifest.dependencies ?? {}));
  const all: ReadonlySet<string> = new Set<string>([
    ...runtime,
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  return { runtime, all };
}

/**
 * 裸说明符所属的包名；相对或绝对路径与运行时内建模块返回 undefined。
 *
 * @param specifier 模块导入说明符
 * @returns 归属的 npm 包名，非外部 npm 包时返回 undefined
 */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || isRuntimeBuiltinModule(specifier)) {
    return undefined;
  }
  const segments: readonly string[] = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/** 单文件依赖声明核对的入参。 */
export interface CollectUndeclaredDependencyProblemsParams {
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 被检查文件的绝对路径。 */
  readonly path: string;
  /** 带父节点指针解析的 AST。 */
  readonly source: ts.SourceFile;
  /** 本作用域允许引用的已声明包名集合（运行期传 `runtime`，脚本/测试传 `all`）。 */
  readonly declaredPackages: ReadonlySet<string>;
  /** 是否仅接受 `package.json` 的 `dependencies`（生产源码传 true，默认 false）。 */
  readonly runtimeOnly?: boolean;
}

/**
 * 列出一个文件里未由根 manifest 直接声明的运行期包引用。
 *
 * @param params 单文件依赖声明核对入参
 * @returns 未声明依赖的违规信息列表
 */
export function collectUndeclaredDependencyProblems({
  projectRoot,
  path,
  source,
  declaredPackages,
  runtimeOnly = false,
}: CollectUndeclaredDependencyProblemsParams): readonly string[] {
  const problems: string[] = [];
  const manifestScope: string = runtimeOnly ? "package.json dependencies" : "package.json dependencies or devDependencies";
  for (const reference of runtimeModuleReferences(source)) {
    const packageName: string | undefined = packageNameOf(reference.specifier);
    if (packageName === undefined || declaredPackages.has(packageName)) continue;
    const line: number = source.getLineAndCharacterOfPosition(reference.start).line + 1;
    problems.push(
      `${relative(projectRoot, path)}:${line} imports ${reference.specifier} at runtime, ` +
      `but ${packageName} is not declared in ${manifestScope}`
    );
  }
  return problems;
}
