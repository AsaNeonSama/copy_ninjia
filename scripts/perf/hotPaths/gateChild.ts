/** 热路径门禁子进程的解码、运行时校验、资源门禁与隔离根清理。 */

import { join } from "node:path";
import { isPlainRecord } from "../../../packages/libs/record";
import { JSC_GC_LOG_ENV } from "../../../packages/consts/environment";
import { summarizeGcPauseProfile } from "./gcProfile";
import type { GcPauseProfile } from "./gcProfile";
import {
  createHotPathGateRuntimeRoot,
  hotPathGateChildEnvironment,
} from "./gateFixture";
import type { HotPathGateFixture } from "./gateFixture";
import { removeMockPath } from "../fullSuite/mockRoot";
import type { HotPathGateCalibration } from "./gateResult";

export interface SamplingProfileResult {
  readonly totalSamples: number;
  readonly llintPercent: number;
  readonly baselinePercent: number;
  readonly dfgPercent: number;
  readonly ftlPercent: number;
}

export interface JitProbeResult {
  readonly dfgCompiles: number;
  readonly reoptRetries: number;
  readonly changedDuringSampling: boolean;
}

export interface ChildProfileResult {
  readonly gcProfile: GcPauseProfile | null;
  readonly scenario: string;
  readonly measurementMode: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly warmupIterations: number;
  readonly medianNsPerOp: number;
  readonly retainedHeapDelta: number | null;
  readonly retainedExtraMemoryDelta: number | null;
  readonly retainedObjectDelta: number | null;
  readonly peakSampledHeapUsedDelta: number;
  readonly peakSampledRssBytes: number;
  readonly processPeakRssBytes: number;
  readonly samplingProfile: SamplingProfileResult | null;
  readonly jit: Readonly<Record<string, JitProbeResult>>;
}

/**
 * 读取并校验对象中的必填字符串字段。
 *
 * @param record 待读取的普通对象
 * @param key 字段名
 * @returns 校验通过的字符串值
 */
function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value: unknown = record[key];
  if (typeof value !== "string") {
    throw new Error(`Hot-path child result omitted string field ${key}.`);
  }
  return value;
}

/**
 * 读取并校验对象中的必填有限数值字段。
 *
 * @param record 待读取的普通对象
 * @param key 字段名
 * @returns 校验通过的有限数值
 */
function requiredNumber(
  record: Readonly<Record<string, unknown>>,
  key: string
): number {
  const value: unknown = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Hot-path child result omitted finite number field ${key}.`);
  }
  return value;
}

/**
 * 读取并校验对象中的必填布尔字段。
 *
 * @param record 待读取的普通对象
 * @param key 字段名
 * @returns 校验通过的布尔值
 */
function requiredBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  const value: unknown = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Hot-path child result omitted boolean field ${key}.`);
  }
  return value;
}

/**
 * 读取并校验对象中的可空有限数值字段。
 *
 * @param record 待读取的普通对象
 * @param key 字段名
 * @returns 校验通过的有限数值或 null
 */
function requiredNullableNumber(
  record: Readonly<Record<string, unknown>>,
  key: string
): number | null {
  const value: unknown = record[key];
  if (value === null) return null;
  return requiredNumber(record, key);
}

/**
 * 解析并校验子进程返回的采样剖析结果。
 *
 * @param value 待解析的原始采样剖析字段值
 * @returns 结构化的采样剖析结果
 */
function parseSamplingProfile(value: unknown): SamplingProfileResult {
  if (!isPlainRecord(value)) {
    throw new Error("Hot-path child result omitted its sampling profile.");
  }
  return {
    totalSamples: requiredNumber(value, "totalSamples"),
    llintPercent: requiredNumber(value, "llintPercent"),
    baselinePercent: requiredNumber(value, "baselinePercent"),
    dfgPercent: requiredNumber(value, "dfgPercent"),
    ftlPercent: requiredNumber(value, "ftlPercent"),
  };
}

/**
 * 解析并校验子进程返回的 JIT 探针字典。
 *
 * @param value 待解析的原始 JIT 探针字段值
 * @returns 探针名到探针结果的只读映射
 */
function parseJitProbes(value: unknown): Readonly<Record<string, JitProbeResult>> {
  if (!isPlainRecord(value)) {
    throw new Error("Hot-path child result omitted its JIT probes.");
  }
  const probes: Record<string, JitProbeResult> = {};
  for (const [name, probe] of Object.entries(value)) {
    if (!isPlainRecord(probe)) {
      throw new Error(`Hot-path child returned an invalid JIT probe ${name}.`);
    }
    probes[name] = {
      dfgCompiles: requiredNumber(probe, "dfgCompiles"),
      reoptRetries: requiredNumber(probe, "reoptRetries"),
      changedDuringSampling: requiredBoolean(probe, "changedDuringSampling"),
    };
  }
  return probes;
}

/**
 * 解析子进程标准输出的 JSON 报告及标准错误中的 GC 日志。
 *
 * @param text 子进程标准输出 JSON 文本
 * @param stderr 子进程标准错误输出文本
 * @returns 解析完成的子进程剖析结果
 */
function parseChildProfileResult(text: string, stderr: string): ChildProfileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Hot-path child did not return valid JSON.");
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("Hot-path child result must be a JSON object.");
  }
  return {
    gcProfile: parsed.measurementMode === "steadyProfile" ? summarizeGcPauseProfile(stderr) : null,
    scenario: requiredString(parsed, "scenario"),
    measurementMode: requiredString(parsed, "measurementMode"),
    bunVersion: requiredString(parsed, "bunVersion"),
    bunRevision: requiredString(parsed, "bunRevision"),
    warmupIterations: requiredNumber(parsed, "warmupIterations"),
    medianNsPerOp: requiredNumber(parsed, "medianNsPerOp"),
    retainedHeapDelta: requiredNullableNumber(parsed, "retainedHeapDelta"),
    retainedExtraMemoryDelta: requiredNullableNumber(parsed, "retainedExtraMemoryDelta"),
    retainedObjectDelta: requiredNullableNumber(parsed, "retainedObjectDelta"),
    peakSampledHeapUsedDelta: requiredNumber(parsed, "peakSampledHeapUsedDelta"),
    peakSampledRssBytes: requiredNumber(parsed, "peakSampledRssBytes"),
    processPeakRssBytes: requiredNumber(parsed, "processPeakRssBytes"),
    samplingProfile: parsed.samplingProfile === null
      ? null
      : parseSamplingProfile(parsed.samplingProfile),
    jit: parseJitProbes(parsed.jit),
  };
}

/**
 * 只返回生产探针，不含 `scenario.run` 编排壳。
 *
 * @param result 子进程剖析结果
 * @returns 过滤掉编排壳后的生产探针结果列表
 */
export function productionJitProbes(
  result: ChildProfileResult
): readonly JitProbeResult[] {
  const probes: JitProbeResult[] = [];
  for (const [name, probe] of Object.entries(result.jit)) {
    if (name !== "scenario.run") probes.push(probe);
  }
  if (probes.length === 0) {
    throw new Error(`${result.scenario}: profile scenario has no production JIT probes.`);
  }
  return probes;
}

/**
 * 断言子进程上报的 Bun 版本、revision、预热轮数与中位耗时合法且与校准记录一致。
 *
 * @param result 子进程剖析结果
 * @param calibration 热路径门禁校准配置
 */
function assertRuntimeMatches(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration
): void {
  if (
    result.bunVersion !== calibration.runtime.bunVersion ||
    result.bunRevision !== calibration.runtime.bunRevision
  ) {
    throw new Error(
      `${result.scenario}: expected Bun ${calibration.runtime.bunVersion} ` +
      `(${calibration.runtime.bunRevision}), received ${result.bunVersion} ` +
      `(${result.bunRevision}); recalibrate the profile thresholds before comparing results.`
    );
  }
  if (!Number.isSafeInteger(result.warmupIterations) || result.warmupIterations <= 0) {
    throw new Error(`${result.scenario}: child returned invalid warmup iterations.`);
  }
  if (result.medianNsPerOp <= 0) {
    throw new Error(`${result.scenario}: child returned invalid median latency.`);
  }
}

/**
 * 断言稳态剖析子进程的采样数、GC 暂停占比与 JIT 探针满足门禁限制。
 *
 * @param result 子进程剖析结果
 * @param calibration 热路径门禁校准配置
 * @param maxGcPausePercent 允许的最大 GC 暂停占比百分比
 */
function assertProfileRunWithinLimits(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration,
  maxGcPausePercent: number
): void {
  assertRuntimeMatches(result, calibration);
  if (result.measurementMode !== "steadyProfile" || result.samplingProfile === null || result.gcProfile === null) {
    throw new Error(`${result.scenario}: child did not return a sampling profile.`);
  }
  if (result.samplingProfile.totalSamples < calibration.limits.minProfileSamples) {
    throw new Error(
      `${result.scenario}: only ${result.samplingProfile.totalSamples} profile samples; ` +
      `expected at least ${calibration.limits.minProfileSamples}.`
    );
  }
  if (result.gcProfile.gcPercent > maxGcPausePercent) {
    throw new Error(
      `${result.scenario}: GC paused for ${result.gcProfile.gcPercent.toFixed(3)}% of ` +
      `steady elapsed time; limit is ${maxGcPausePercent}%.`
    );
  }
  for (const probe of productionJitProbes(result)) {
    if (probe.dfgCompiles < 1) {
      throw new Error(`${result.scenario}: a production probe did not enter DFG during warmup.`);
    }
    if (probe.changedDuringSampling) {
      throw new Error(
        `${result.scenario}: a production probe recompiled or deoptimized during steady sampling.`
      );
    }
  }
}

/**
 * 断言留存内存子进程的 RSS、采样堆增量及留存堆/对象增量满足门禁限制。
 *
 * @param result 子进程剖析结果
 * @param calibration 热路径门禁校准配置
 */
function assertRetainedRunWithinLimits(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration
): void {
  assertRuntimeMatches(result, calibration);
  if (
    result.measurementMode !== "retained" ||
    result.samplingProfile !== null ||
    result.retainedHeapDelta === null ||
    result.retainedExtraMemoryDelta === null ||
    result.retainedObjectDelta === null
  ) {
    throw new Error(`${result.scenario}: child did not return retained-memory results.`);
  }
  if (
    result.peakSampledRssBytes > calibration.limits.maxRssBytes ||
    result.processPeakRssBytes > calibration.limits.maxRssBytes
  ) {
    throw new Error(`${result.scenario}: RSS exceeded ${calibration.limits.maxRssBytes} bytes.`);
  }
  if (result.peakSampledHeapUsedDelta > calibration.limits.maxSampledHeapGrowthBytes) {
    throw new Error(`${result.scenario}: sampled heapUsed growth exceeded its limit.`);
  }
  if (result.retainedHeapDelta > calibration.limits.maxRetainedHeapGrowthBytes) {
    throw new Error(`${result.scenario}: retained JSC heap growth exceeded its limit.`);
  }
  if (
    result.retainedExtraMemoryDelta >
      calibration.limits.maxRetainedExtraMemoryGrowthBytes
  ) {
    throw new Error(`${result.scenario}: retained extra memory growth exceeded its limit.`);
  }
  if (result.retainedObjectDelta > calibration.limits.maxRetainedObjectGrowth) {
    throw new Error(`${result.scenario}: retained object growth exceeded its limit.`);
  }
}

export interface RunHotPathGateChildOptions {
  /** 仓库根目录绝对路径。 */
  readonly projectRoot: string;
  /** 待运行的热路径场景名称。 */
  readonly scenario: string;
  /** 子进程测量模式（留存内存或稳态剖析）。 */
  readonly measurementMode: "retained" | "steadyProfile";
  /** 门禁共用的隔离配置与运行目录夹具。 */
  readonly fixture: HotPathGateFixture;
  /** 热路径门禁校准配置。 */
  readonly calibration: HotPathGateCalibration;
  /** 稳态进程 GC 暂停占比的硬上限：CPU 分档预算加软超限余量。 */
  readonly maxGcPausePercent: number;
}

/**
 * 运行一轮隔离子进程，严格解码并执行对应的 profile 或 retained 门禁。
 *
 * @param options 子进程运行与门禁校验选项
 * @returns 通过门禁校验的子进程剖析结果
 */
export async function runHotPathGateChild({
  projectRoot,
  scenario,
  measurementMode,
  fixture,
  calibration,
  maxGcPausePercent,
}: RunHotPathGateChildOptions): Promise<ChildProfileResult> {
  const args: string[] = [
    Bun.argv[0]!,
    join(projectRoot, "scripts/perf/hotPaths.ts"),
    scenario,
  ];
  if (measurementMode === "steadyProfile") args.push("--profile");
  const runtimeRoot: string = createHotPathGateRuntimeRoot(fixture);
  try {
    const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(args, {
      cwd: projectRoot,
      env: { ...hotPathGateChildEnvironment(fixture, runtimeRoot), [JSC_GC_LOG_ENV]: measurementMode === "steadyProfile" ? "1" : "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise: Promise<string> = subprocess.stdout.text();
    const stderrPromise: Promise<string> = subprocess.stderr.text();
    const exitCode: number = await subprocess.exited;
    const stdout: string = await stdoutPromise;
    const stderr: string = await stderrPromise;
    if (exitCode !== 0) {
      throw new Error(
        `${scenario}: hot-path profile child exited ${exitCode}: ${stderr.trim()}`
      );
    }
    const result: ChildProfileResult = parseChildProfileResult(stdout.trim(), stderr);
    if (result.scenario !== scenario) {
      throw new Error(`${scenario}: child returned scenario ${result.scenario}.`);
    }
    if (measurementMode === "steadyProfile") {
      assertProfileRunWithinLimits(result, calibration, maxGcPausePercent);
    } else {
      assertRetainedRunWithinLimits(result, calibration);
    }
    return result;
  } finally {
    removeMockPath(runtimeRoot);
  }
}
