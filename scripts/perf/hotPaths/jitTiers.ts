/** JSC 分层计数的采集与做差；判读口径见 types.ts 上的 JitTierCounts/JitTierStats。 */

import { numberOfDFGCompiles, reoptimizationRetryCount } from "bun:jsc";
import type { JitProbe, JitTierCounts, JitTierStats, Scenario } from "./types";

/**
 * 按原型上的方法名建立探针表：键为 `<label>.<方法名>`，值为原型上的该方法。
 *
 * @param label 原型所属类名标签
 * @param prototype 目标原型对象
 * @param keys 待提取的方法名列表
 * @returns 探针名称到函数的只读映射
 */
export function prototypeProbes<T extends object>(
  label: string,
  prototype: T,
  keys: readonly (keyof T & string)[]
): Readonly<Record<string, JitProbe>> {
  const probes: Record<string, JitProbe> = {};
  for (const key of keys) {
    probes[`${label}.${key}`] = prototype[key] as JitProbe;
  }
  return probes;
}

/**
 * 读取各热函数此刻的分层计数。这两个数由 JSC 挂在函数的 executable 上累计，
 * 只增不减，不随堆快照或 GC 归零，可在不同时刻取两次做差。
 *
 * 固定包含 `scenario.run`，它是承载整个计时循环的闭包。
 *
 * @param scenario 待采集的热路径场景对象
 * @returns 探针名称到当前分层计数的映射
 */
export function collectJitTiers(scenario: Scenario): Record<string, JitTierCounts> {
  const tiers: Record<string, JitTierCounts> = {
    "scenario.run": {
      dfgCompiles: numberOfDFGCompiles(scenario.run),
      reoptRetries: reoptimizationRetryCount(scenario.run),
    },
  };
  for (const [name, probe] of Object.entries(scenario.probes ?? {})) {
    tiers[name] = {
      dfgCompiles: numberOfDFGCompiles(probe),
      reoptRetries: reoptimizationRetryCount(probe),
    };
  }
  return tiers;
}

/**
 * 用预热后与采样后两份计数得出最终分层结果。计数只增不减，任一项变大表示该函数
 * 在计时窗口内又被编译或去优化过一次。
 *
 * @param afterWarmup 预热结束时的分层计数快照
 * @param afterSampling 正式采样结束时的分层计数快照
 * @returns 探针名称到最终分层统计结果的映射
 */
export function diffJitTiers(
  afterWarmup: Readonly<Record<string, JitTierCounts>>,
  afterSampling: Readonly<Record<string, JitTierCounts>>
): Record<string, JitTierStats> {
  const stats: Record<string, JitTierStats> = {};
  for (const [name, sampled] of Object.entries(afterSampling)) {
    const warmed: JitTierCounts | undefined = afterWarmup[name];
    stats[name] = {
      dfgCompiles: sampled.dfgCompiles,
      reoptRetries: sampled.reoptRetries,
      changedDuringSampling:
        warmed === undefined ||
        sampled.dfgCompiles > warmed.dfgCompiles ||
        sampled.reoptRetries > warmed.reoptRetries,
    };
  }
  return stats;
}
