/**
 * 热路径门禁子进程剖析器（`gateChild.ts`）与 JSC 分层探针采集器（`jitTiers.ts`）单元测试：
 * - 验证 `prototypeProbes`、`collectJitTiers` 与 `diffJitTiers` 的探针映射、计数增量及去优化告警判定；
 * - 验证 `productionJitProbes` 过滤 `scenario.run` 并在缺失生产探针时抛错；
 * - 经隔离项目根内的替身 `scripts/perf/hotPaths.ts` 覆盖非零退出、畸形 JSON、场景/版本错配、
 *   `steadyProfile`（样本不足、GC 暂停超限、未进 DFG、采样期重编译）与 `retained`（RSS、采样堆、留存堆/外存/对象超限）全部边界分支。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOT_PATH_GC_WINDOW_END,
  HOT_PATH_GC_WINDOW_START,
} from "../../packages/consts/performance";
import {
  productionJitProbes,
  runHotPathGateChild,
} from "../../scripts/perf/hotPaths/gateChild";
import type { ChildProfileResult } from "../../scripts/perf/hotPaths/gateChild";
import {
  createHotPathGateFixture,
  removeHotPathGateFixture,
} from "../../scripts/perf/hotPaths/gateFixture";
import type { HotPathGateFixture } from "../../scripts/perf/hotPaths/gateFixture";
import type { HotPathGateCalibration } from "../../scripts/perf/hotPaths/gateResult";
import {
  collectJitTiers,
  diffJitTiers,
  prototypeProbes,
} from "../../scripts/perf/hotPaths/jitTiers";
import type { JitTierCounts, Scenario } from "../../scripts/perf/hotPaths/types";
import { removeCreatedPerformanceMockRootAfterAll } from "../helpers/performanceMockRoot";

removeCreatedPerformanceMockRootAfterAll();

const tempRoots: string[] = [];
const fixturesToRemove: HotPathGateFixture[] = [];

afterAll((): void => {
  for (const fixture of fixturesToRemove.splice(0, fixturesToRemove.length)) {
    removeHotPathGateFixture(fixture);
  }
  for (const dir of tempRoots.splice(0, tempRoots.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 默认校准基准配置。 */
const TEST_CALIBRATION: HotPathGateCalibration = {
  runtime: {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
  },
  limits: {
    minProfileSamples: 100,
    maxRssBytes: 512 * 1024 * 1024,
    maxSampledHeapGrowthBytes: 16 * 1024 * 1024,
    maxRetainedHeapGrowthBytes: 4 * 1024 * 1024,
    maxRetainedExtraMemoryGrowthBytes: 4 * 1024 * 1024,
    maxRetainedObjectGrowth: 5_000,
  },
  medianNsPerOpReportThresholds: {
    "demo-scenario": 1_000,
  },
};

/**
 * 构造一个符合 `ChildProfileResult` JSON 结构的测试报告载荷。
 * @param mode 子进程测量模式。
 * @param overrides 需覆盖的顶层字段。
 * @returns 完整可序列化的子进程输出对象（不含解码后生成的 `gcProfile`）。
 */
function buildChildPayload(
  mode: "retained" | "steadyProfile",
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    scenario: "demo-scenario",
    measurementMode: mode,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    warmupIterations: 1_000,
    medianNsPerOp: 42.5,
    retainedHeapDelta: mode === "retained" ? 128 : null,
    retainedExtraMemoryDelta: mode === "retained" ? 64 : null,
    retainedObjectDelta: mode === "retained" ? 4 : null,
    peakSampledHeapUsedDelta: 1_024,
    peakSampledRssBytes: 64 * 1024 * 1024,
    processPeakRssBytes: 64 * 1024 * 1024,
    samplingProfile:
      mode === "steadyProfile"
        ? {
          totalSamples: 250,
          llintPercent: 1,
          baselinePercent: 2,
          dfgPercent: 20,
          ftlPercent: 77,
        }
        : null,
    jit: {
      "scenario.run": {
        dfgCompiles: 1,
        reoptRetries: 0,
        changedDuringSampling: false,
      },
      "prod.hotFn": {
        dfgCompiles: 2,
        reoptRetries: 0,
        changedDuringSampling: false,
      },
    },
  };
  return { ...base, ...overrides };
}

/**
 * 在隔离临时项目根写入受控 `scripts/perf/hotPaths.ts` 替身并调用 `runHotPathGateChild`。
 * @param options 测量模式、脚本输出内容、退出码及校准参数。
 * @returns 解码且通过门禁后的 `ChildProfileResult`。
 */
async function invokeStubGateChild(options: {
  readonly mode: "retained" | "steadyProfile";
  readonly stdoutLine: string;
  readonly stderrLines?: readonly string[];
  readonly exitCode?: number;
  readonly calibration?: HotPathGateCalibration;
  readonly maxGcPausePercent?: number;
}): Promise<ChildProfileResult> {
  const projectRoot: string = mkdtempSync(join(tmpdir(), "hot-path-gate-child-"));
  tempRoots.push(projectRoot);
  mkdirSync(join(projectRoot, "scripts/perf"), { recursive: true });
  const fixture: HotPathGateFixture = await createHotPathGateFixture();
  fixturesToRemove.push(fixture);

  const lines: string[] = [];
  for (const errLine of options.stderrLines ?? []) {
    lines.push(`console.error(${JSON.stringify(errLine)});`);
  }
  lines.push(`console.log(${JSON.stringify(options.stdoutLine)});`);
  if (options.exitCode !== undefined && options.exitCode !== 0) {
    lines.push(`process.exit(${options.exitCode});`);
  }
  await Bun.write(join(projectRoot, "scripts/perf/hotPaths.ts"), `${lines.join("\n")}\n`);

  return runHotPathGateChild({
    projectRoot,
    scenario: "demo-scenario",
    measurementMode: options.mode,
    fixture,
    calibration: options.calibration ?? TEST_CALIBRATION,
    maxGcPausePercent: options.maxGcPausePercent ?? 1.5,
  });
}

describe("JSC 分层探针采集与做差（jitTiers.ts）", (): void => {
  test("prototypeProbes、collectJitTiers 与 diffJitTiers 准确捕获编译增量、缺失预热与稳定探针", (): void => {
    class Counter {
      step(): number {
        return 1;
      }
    }
    const probes = prototypeProbes("Counter", Counter.prototype, ["step"]);
    expect(Object.keys(probes)).toEqual(["Counter.step"]);
    expect(probes["Counter.step"]).toBe(Counter.prototype.step);

    const scenario: Scenario = {
      iterations: 10,
      run: (iterations: number): number => iterations,
      probes,
    };
    const collected: Record<string, JitTierCounts> = collectJitTiers(scenario);
    expect(Object.keys(collected)).toEqual(["scenario.run", "Counter.step"]);
    expect(Number.isSafeInteger(collected["scenario.run"]!.dfgCompiles)).toBeTrue();
    expect(Number.isSafeInteger(collected["Counter.step"]!.reoptRetries)).toBeTrue();

    const diff: Record<string, { changedDuringSampling: boolean; dfgCompiles: number; reoptRetries: number }> =
      diffJitTiers(
        {
          stable: { dfgCompiles: 2, reoptRetries: 0 },
          dfgGrew: { dfgCompiles: 1, reoptRetries: 0 },
          reoptGrew: { dfgCompiles: 1, reoptRetries: 1 },
        },
        {
          stable: { dfgCompiles: 2, reoptRetries: 0 },
          dfgGrew: { dfgCompiles: 2, reoptRetries: 0 },
          reoptGrew: { dfgCompiles: 1, reoptRetries: 2 },
          addedLater: { dfgCompiles: 1, reoptRetries: 0 },
        }
      );

    expect(diff.stable?.changedDuringSampling).toBeFalse();
    expect(diff.dfgGrew?.changedDuringSampling).toBeTrue();
    expect(diff.reoptGrew?.changedDuringSampling).toBeTrue();
    expect(diff.addedLater?.changedDuringSampling).toBeTrue();
  });
});

describe("热路径门禁子进程解码与超限判定（gateChild.ts）", (): void => {
  test("productionJitProbes 过滤 scenario.run 并在缺失生产探针时抛错", (): void => {
    const valid = {
      ...buildChildPayload("retained"),
      gcProfile: null,
    } as unknown as ChildProfileResult;
    expect(productionJitProbes(valid)).toEqual([
      { dfgCompiles: 2, reoptRetries: 0, changedDuringSampling: false },
    ]);

    const onlyShell = {
      ...buildChildPayload("retained", {
        jit: {
          "scenario.run": { dfgCompiles: 1, reoptRetries: 0, changedDuringSampling: false },
        },
      }),
      gcProfile: null,
    } as unknown as ChildProfileResult;
    expect((): readonly unknown[] => productionJitProbes(onlyShell)).toThrow(
      "no production JIT probes"
    );
  });

  test("拒绝非零退出、非法 JSON、场景名或运行时版本错配", async (): Promise<void> => {
    await expect(
      invokeStubGateChild({
        mode: "retained",
        stdoutLine: "{}",
        stderrLines: ["boom stderr"],
        exitCode: 2,
      })
    ).rejects.toThrow("hot-path profile child exited 2: boom stderr");

    await expect(
      invokeStubGateChild({
        mode: "retained",
        stdoutLine: "{not-json",
      })
    ).rejects.toThrow("did not return valid JSON");

    await expect(
      invokeStubGateChild({
        mode: "retained",
        stdoutLine: "[]",
      })
    ).rejects.toThrow("must be a JSON object");

    await expect(
      invokeStubGateChild({
        mode: "retained",
        stdoutLine: JSON.stringify(buildChildPayload("retained", { scenario: "other-scenario" })),
      })
    ).rejects.toThrow("child returned scenario other-scenario");

    await expect(
      invokeStubGateChild({
        mode: "retained",
        stdoutLine: JSON.stringify(buildChildPayload("retained", { bunVersion: "0.0.0-mismatch" })),
      })
    ).rejects.toThrow("recalibrate the profile thresholds");
  });

  test("steadyProfile 模式接受合规测量并拒绝样本不足、GC 暂停超限、未进 DFG 与重编译", async (): Promise<void> => {
    const cleanGcWindow: readonly string[] = [
      HOT_PATH_GC_WINDOW_START,
      `${HOT_PATH_GC_WINDOW_END} 100`,
    ];

    const passed: ChildProfileResult = await invokeStubGateChild({
      mode: "steadyProfile",
      stdoutLine: JSON.stringify(buildChildPayload("steadyProfile")),
      stderrLines: cleanGcWindow,
    });
    expect(passed.gcProfile?.pauseCount).toBe(0);
    expect(passed.samplingProfile?.totalSamples).toBe(250);

    await expect(
      invokeStubGateChild({
        mode: "steadyProfile",
        stdoutLine: JSON.stringify(
          buildChildPayload("steadyProfile", {
            samplingProfile: {
              totalSamples: 10,
              llintPercent: 5,
              baselinePercent: 5,
              dfgPercent: 20,
              ftlPercent: 70,
            },
          })
        ),
        stderrLines: cleanGcWindow,
      })
    ).rejects.toThrow("expected at least 100");

    await expect(
      invokeStubGateChild({
        mode: "steadyProfile",
        stdoutLine: JSON.stringify(buildChildPayload("steadyProfile")),
        stderrLines: [
          HOT_PATH_GC_WINDOW_START,
          "[GC<0x1234>: M 1/1 -> p=50.0ms (max 50.0), cycle 50.0ms END]",
          `${HOT_PATH_GC_WINDOW_END} 100`,
        ],
        maxGcPausePercent: 1.5,
      })
    ).rejects.toThrow("GC paused for 50.000%");

    await expect(
      invokeStubGateChild({
        mode: "steadyProfile",
        stdoutLine: JSON.stringify(
          buildChildPayload("steadyProfile", {
            jit: {
              "scenario.run": { dfgCompiles: 1, reoptRetries: 0, changedDuringSampling: false },
              "prod.hotFn": { dfgCompiles: 0, reoptRetries: 0, changedDuringSampling: false },
            },
          })
        ),
        stderrLines: cleanGcWindow,
      })
    ).rejects.toThrow("did not enter DFG");

    await expect(
      invokeStubGateChild({
        mode: "steadyProfile",
        stdoutLine: JSON.stringify(
          buildChildPayload("steadyProfile", {
            jit: {
              "scenario.run": { dfgCompiles: 1, reoptRetries: 0, changedDuringSampling: false },
              "prod.hotFn": { dfgCompiles: 3, reoptRetries: 0, changedDuringSampling: true },
            },
          })
        ),
        stderrLines: cleanGcWindow,
      })
    ).rejects.toThrow("recompiled or deoptimized");
  });

  test("retained 模式接受合规内存增长并在 RSS/采样堆/留存堆/外存/对象数超限时逐一失败", async (): Promise<void> => {
    const passed: ChildProfileResult = await invokeStubGateChild({
      mode: "retained",
      stdoutLine: JSON.stringify(buildChildPayload("retained")),
    });
    expect(passed.gcProfile).toBeNull();
    expect(passed.retainedHeapDelta).toBe(128);

    const overLimitCases: readonly (readonly [Record<string, unknown>, string])[] = [
      [{ peakSampledRssBytes: TEST_CALIBRATION.limits.maxRssBytes + 1 }, "RSS exceeded"],
      [
        { peakSampledHeapUsedDelta: TEST_CALIBRATION.limits.maxSampledHeapGrowthBytes + 1 },
        "sampled heapUsed growth exceeded",
      ],
      [
        { retainedHeapDelta: TEST_CALIBRATION.limits.maxRetainedHeapGrowthBytes + 1 },
        "retained JSC heap growth exceeded",
      ],
      [
        {
          retainedExtraMemoryDelta:
            TEST_CALIBRATION.limits.maxRetainedExtraMemoryGrowthBytes + 1,
        },
        "retained extra memory growth exceeded",
      ],
      [
        { retainedObjectDelta: TEST_CALIBRATION.limits.maxRetainedObjectGrowth + 1 },
        "retained object growth exceeded",
      ],
    ];

    for (const [overrides, expectedMessage] of overLimitCases) {
      await expect(
        invokeStubGateChild({
          mode: "retained",
          stdoutLine: JSON.stringify(buildChildPayload("retained", overrides)),
        })
      ).rejects.toThrow(expectedMessage);
    }
  });
});
