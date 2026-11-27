/**
 * `scripts/perf/hotPaths/gateLimits.ts` 热路径 GC 分档预算、软超限、中位耗时与策略覆盖校验纯函数单测。
 */
import { describe, expect, test } from "bun:test";
import {
  HOT_PATH_CALIBRATION_STALE_RATIO,
  HOT_PATH_GC_CPU_BUDGETS,
  HOT_PATH_GC_SOFT_OVERRUN_PERCENT,
} from "../../packages/consts/performance";
import {
  assertHotPathMedianPolicyCoverage,
  createHotPathCalibrationStaleReport,
  createHotPathGcSoftReport,
  createHotPathMedianLatencyReport,
  hotPathGcPauseFailPercent,
  selectHotPathGcPausePercentLimit,
} from "../../scripts/perf/hotPaths/gateLimits";

describe("hotPaths/gateLimits 纯判定函数", () => {
  test("selectHotPathGcPausePercentLimit 按 CPU 降序分档选定预算并拒绝非正整数", () => {
    for (const tier of HOT_PATH_GC_CPU_BUDGETS) {
      expect(selectHotPathGcPausePercentLimit(tier.minCpuCount)).toBe(tier.maxPausePercent);
    }
    expect(selectHotPathGcPausePercentLimit(1_024)).toBe(
      HOT_PATH_GC_CPU_BUDGETS[0]!.maxPausePercent
    );
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((): number => selectHotPathGcPausePercentLimit(invalid)).toThrow(
        "positive integer CPU count"
      );
    }
  });

  test("hotPathGcPauseFailPercent 与 createHotPathGcSoftReport 严守软预算与硬上限边界", () => {
    const budget: number = 10;
    const expectedFail: number = budget + HOT_PATH_GC_SOFT_OVERRUN_PERCENT;
    expect(hotPathGcPauseFailPercent(budget)).toBe(expectedFail);
    expect(
      createHotPathGcSoftReport({ scenario: "s1", gcPercent: budget, budgetPercent: budget })
    ).toBeNull();
    expect(
      createHotPathGcSoftReport({ scenario: "s1", gcPercent: budget + 0.5, budgetPercent: budget })
    ).toEqual({
      scenario: "s1",
      gcPercent: budget + 0.5,
      budgetPercent: budget,
      failPercent: expectedFail,
    });
  });

  test("createHotPathMedianLatencyReport 在超出阈值时计算绝对超限与百分比，未超返回 null", () => {
    expect(
      createHotPathMedianLatencyReport({
        scenario: "s1",
        medianNsPerOp: 100,
        bunRevision: "rev-1",
        reportThresholdNsPerOp: 100,
      })
    ).toBeNull();
    expect(
      createHotPathMedianLatencyReport({
        scenario: "s1",
        medianNsPerOp: 125,
        bunRevision: "rev-1",
        reportThresholdNsPerOp: 100,
      })
    ).toEqual({
      scenario: "s1",
      medianNsPerOp: 125,
      reportThresholdNsPerOp: 100,
      overrunNsPerOp: 25,
      overrunPercent: 25,
      bunRevision: "rev-1",
    });
  });

  test("createHotPathCalibrationStaleReport 按 HOT_PATH_CALIBRATION_STALE_RATIO 识别过松校准", () => {
    const median: number = 100;
    const boundary: number = median * HOT_PATH_CALIBRATION_STALE_RATIO;
    expect(
      createHotPathCalibrationStaleReport({
        scenario: "s1",
        medianNsPerOp: median,
        bunRevision: "rev-1",
        reportThresholdNsPerOp: boundary,
      })
    ).toBeNull();
    expect(
      createHotPathCalibrationStaleReport({
        scenario: "s1",
        medianNsPerOp: median,
        bunRevision: "rev-1",
        reportThresholdNsPerOp: boundary + 50,
      })
    ).toEqual({
      scenario: "s1",
      medianNsPerOp: median,
      reportThresholdNsPerOp: boundary + 50,
      headroomRatio: (boundary + 50) / median,
    });
  });

  test("assertHotPathMedianPolicyCoverage 强制场景与阈值表一一对应，拒绝重复、缺项、非正数与孤立阈值", () => {
    const valid: ReadonlyMap<string, number> = assertHotPathMedianPolicyCoverage(
      ["alpha", "beta"],
      { alpha: 10, beta: 25.5 }
    );
    expect([...valid.entries()]).toEqual([["alpha", 10], ["beta", 25.5]]);

    expect((): ReadonlyMap<string, number> =>
      assertHotPathMedianPolicyCoverage(["alpha", "alpha"], { alpha: 10 })
    ).toThrow("is duplicated");
    expect((): ReadonlyMap<string, number> =>
      assertHotPathMedianPolicyCoverage(["alpha", "beta"], { alpha: 10 })
    ).toThrow("has no positive median policy");
    for (const badThreshold of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((): ReadonlyMap<string, number> =>
        assertHotPathMedianPolicyCoverage(["alpha"], { alpha: badThreshold })
      ).toThrow("has no positive median policy");
    }
    expect((): ReadonlyMap<string, number> =>
      assertHotPathMedianPolicyCoverage(["alpha"], { alpha: 10, orphan: 20 })
    ).toThrow("has no default scenario");
  });
});
