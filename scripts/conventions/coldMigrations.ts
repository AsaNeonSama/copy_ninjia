import { join } from "node:path";

import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import type { ColdMigrationEdge } from "../migrations/active";

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 核对 package 只暴露 migrations/active.ts 声明的冷迁移边，一条不多、一条不少。
 *
 * @param projectRoot 仓库根目录绝对路径
 * @returns 冷迁移脚本声明不一致或缺失入口的违规信息列表
 */
export async function collectColdMigrationProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const packageJson: ProjectPackageJson = JSON.parse(
    await Bun.file(join(projectRoot, "package.json")).text()
  ) as ProjectPackageJson;
  const scripts: Readonly<Record<string, string>> = packageJson.scripts ?? {};
  const migrationCommands: string[] = Object.keys(scripts).filter(
    (command: string): boolean => command.startsWith("migrate:")
  ).sort();
  const declaredCommands: string[] = ACTIVE_COLD_MIGRATION_EDGES.map(
    (edge: ColdMigrationEdge): string => edge.command
  ).sort();
  const problems: string[] = [];
  if (migrationCommands.join(",") !== declaredCommands.join(",")) {
    problems.push(
      "package.json must expose exactly the declared active cold migration commands " +
      (declaredCommands.length === 0 ? "(none)" : declaredCommands.join(", "))
    );
  }
  for (const edge of ACTIVE_COLD_MIGRATION_EDGES) {
    if (scripts[edge.command] !== edge.invocation) {
      problems.push(`${edge.command} must invoke ${edge.invocation}`);
    }
    if (!(await Bun.file(join(projectRoot, edge.entryPath)).exists())) {
      problems.push(`active cold migration entry does not exist: ${edge.entryPath}`);
    }
  }
  return problems;
}
