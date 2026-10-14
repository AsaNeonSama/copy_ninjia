/** owner: workers/antiRaid。入群守卫 Worker 侧的通知风格只读镜像。 */

import type { Atmosphere } from "../../../types/atmosphere";

/**
 * 进程通知风格镜像。权威线程为主线程，填充：通过 agentConfig 消息全量注入，业务侧只读。
 * 清理：Worker 停止时清空；重建：Worker 崩溃或进程重启后由主线程在业务消息前重放（见 docs/cn/04-invariants.md）。
 * 无条目（null）时读取配置默认通知风格，不沿用旧值。容量固定为单个枚举槽位，不淘汰。
 */
export const atmosphereState: { current: Atmosphere | null } = { current: null };
