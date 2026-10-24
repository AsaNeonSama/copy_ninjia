import { availableParallelism, totalmem } from "node:os";
import {
  BOT_STATUS_MICROSECONDS_PER_SECOND,
  BOT_STATUS_PERCENT_SCALE,
} from "../consts/botStatus";
import type { BotProcessStatus } from "../types/botStatus";

/** calculateBotProcessStatus 的原始采样输入。 */
export interface CalculateBotProcessStatusOptions {
  /** 进程已运行的秒数。 */
  readonly uptimeSeconds: number;
  /** 进程累计用户态 CPU 时间（微秒）。 */
  readonly cpuUserMicroseconds: number;
  /** 进程累计内核态 CPU 时间（微秒）。 */
  readonly cpuSystemMicroseconds: number;
  /** 当前可用的逻辑 CPU 核心数。 */
  readonly availableCpuCount: number;
  /** Bun 原生采样的进程物理内存占用字节数；无法采样时为 null。 */
  readonly memoryFootprintBytes: number | null;
  /** 容器或 cgroup 限制的内存上限字节数；无限制时为 0。 */
  readonly constrainedMemoryBytes: number;
  /** 宿主机总物理内存字节数。 */
  readonly totalMemoryBytes: number;
}

/**
 * 将非有限或小于等于 0 的数值归零。
 * @param value 待归一的数值。
 * @returns 大于 0 的有限数返回原值，否则返回 0。
 */
function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 把一次同步采样换算成有限的展示值。CPU 使用运行期累计值；
 * 多 Worker 消耗按可用逻辑核归一，结果表达可用算力中的平均份额。
 * @param options 进程运行时间、CPU 与内存的原始采样输入。
 * @returns 归一化后的进程状态指标。
 */
export function calculateBotProcessStatus({
  uptimeSeconds,
  cpuUserMicroseconds,
  cpuSystemMicroseconds,
  availableCpuCount,
  memoryFootprintBytes,
  constrainedMemoryBytes,
  totalMemoryBytes,
}: CalculateBotProcessStatusOptions): BotProcessStatus {
  const safeUptimeSeconds: number = finiteNonNegative(uptimeSeconds);
  const safeCpuCount: number = Math.max(1, Math.floor(finiteNonNegative(availableCpuCount)));
  const cpuMicroseconds: number = finiteNonNegative(cpuUserMicroseconds) +
    finiteNonNegative(cpuSystemMicroseconds);
  const elapsedCpuCapacity: number = safeUptimeSeconds *
    BOT_STATUS_MICROSECONDS_PER_SECOND * safeCpuCount;
  const averageCpuPercent: number = elapsedCpuCapacity === 0
    ? 0
    : Math.min(
      BOT_STATUS_PERCENT_SCALE,
      cpuMicroseconds / elapsedCpuCapacity * BOT_STATUS_PERCENT_SCALE
    );
  const safeMemoryBytes: number | null = memoryFootprintBytes !== null &&
    Number.isFinite(memoryFootprintBytes) && memoryFootprintBytes >= 0
    ? memoryFootprintBytes : null;
  const constrainedBytes: number = finiteNonNegative(constrainedMemoryBytes);
  const memoryLimitBytes: number = constrainedBytes > 0
    ? constrainedBytes
    : finiteNonNegative(totalMemoryBytes);
  const memoryPercent: number = memoryLimitBytes === 0 || safeMemoryBytes === null
    ? 0
    : safeMemoryBytes / memoryLimitBytes * BOT_STATUS_PERCENT_SCALE;
  return {
    uptimeSeconds: safeUptimeSeconds,
    averageCpuPercent,
    availableCpuCount: safeCpuCount,
    memoryFootprintBytes: safeMemoryBytes,
    memoryLimitBytes,
    memoryPercent,
  };
}

/**
 * 同步读取进程指标与 Bun 原生当前内存占用；无法采样时保留 null，不创建后台采样。
 * @returns 当前进程的 CPU、内存与运行时长状态快照。
 */
export function readBotProcessStatus(): BotProcessStatus {
  const cpuUsage: NodeJS.CpuUsage = process.cpuUsage();
  return calculateBotProcessStatus({
    uptimeSeconds: process.uptime(),
    cpuUserMicroseconds: cpuUsage.user,
    cpuSystemMicroseconds: cpuUsage.system,
    availableCpuCount: availableParallelism(),
    memoryFootprintBytes: Bun.unsafe.memoryFootprint() ?? null,
    constrainedMemoryBytes: process.constrainedMemory(),
    totalMemoryBytes: totalmem(),
  });
}
