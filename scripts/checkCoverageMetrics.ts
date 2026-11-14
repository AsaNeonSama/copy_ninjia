import { join } from "node:path";
import { declaredCoverageMetrics } from "./conventions/coverageMetrics";
import type { CoverageMetrics } from "./conventions/coverageMetrics";
import { parseCoverageSummary } from "./coverageSummary";

/**
 * 现跑一次 `bun test --isolate --coverage`，核对仓库声明的覆盖率指标与真实读数一致。
 *
 * 与 `bun run check:conventions` 里那层的分工写在 conventions/coverageMetrics.ts
 * 的头注：那层只判各位置彼此一致；这一层判它们与真实读数一致，整跑一遍测试，
 * 不进 `bun run check`，由 `bun run release:check` 与显式指令触发。
 *
 * 失败时只报差异，不改文件：要改哪些位置见 docs/cn/05-dev-workflow.md 的
 * 「同步 README 指标」。
 */

const PROJECT_ROOT: string = join(import.meta.dir, "..");

/** `runCoverageMetricsCheck` 的可注入检查参数。 */
export interface CheckCoverageMetricsOptions {
  /** 仓库根目录绝对路径（默认当前仓库根）。 */
  readonly projectRoot?: string;
  /** 可选覆盖率实测回调（默认运行 `bun test --isolate --coverage`）。 */
  readonly measure?: () => CoverageMetrics;
}

/**
 * 在仓库根目录执行 `bun test --isolate --coverage` 并解析覆盖率摘要。
 *
 * @returns 实测得到的覆盖率指标
 */
export function measuredCoverageMetrics(): CoverageMetrics {
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["bun", "test", "--isolate", "--coverage", "--coverage-reporter=text"],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  // bun test 把摘要与覆盖率表都写到 stderr；两股都读，不依赖它写在哪一股。
  const decoder: TextDecoder = new TextDecoder();
  const output: string = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`;
  if (result.exitCode !== 0) {
    throw new Error(
      "bun test --coverage failed; fix the suite before syncing the metrics."
    );
  }
  return parseCoverageSummary(output);
}

/**
 * 将覆盖率指标格式化为便于对照的单行文本。
 *
 * @param metrics 覆盖率指标对象
 * @returns 格式化后的覆盖率摘要字符串
 */
export function formatCoverageMetrics(metrics: CoverageMetrics): string {
  return `${metrics.tests} tests / ${metrics.files} files / ` +
    `${metrics.expectCalls} expect() calls / ` +
    `${metrics.functionPercent}% function coverage / ` +
    `${metrics.linePercent}% line coverage`;
}

/**
 * 核对仓库声明的覆盖率指标与实测读数是否一致，并输出差异报告。
 *
 * @param options 仓库根目录与覆盖率实测回调配置
 * @returns 一致时返回 0，缺失或过期时返回 1
 */
export async function runCoverageMetricsCheck({
  projectRoot = PROJECT_ROOT,
  measure = measuredCoverageMetrics,
}: CheckCoverageMetricsOptions = {}): Promise<number> {
  const problems: string[] = [];
  const declared: CoverageMetrics | null = await declaredCoverageMetrics(
    projectRoot,
    problems
  );
  if (declared === null) {
    console.error("Coverage metric check failed before measuring:");
    for (const problem of problems) console.error(`- ${problem}`);
    return 1;
  }

  const measured: CoverageMetrics = measure();
  if (formatCoverageMetrics(declared) === formatCoverageMetrics(measured)) {
    console.log(`Coverage metrics are current: ${formatCoverageMetrics(measured)}`);
    return 0;
  }
  console.error("Coverage metrics are stale:");
  console.error(`- declared: ${formatCoverageMetrics(declared)}`);
  console.error(`- measured: ${formatCoverageMetrics(measured)}`);
  console.error(
    "Rewrite every location listed under 「同步 README 指标」 in docs/cn/05-dev-workflow.md."
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = await runCoverageMetricsCheck();
}
