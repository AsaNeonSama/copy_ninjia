/**
 * AI 模型请求的配额 lane 管理：按供应商协议、端点与凭据映射交互优先的有界任务执行器。
 */

import { aiProviderQuotaLanes } from "../cache/workers/aiChat/providerScheduler";
import {
  AI_PROVIDER_BACKGROUND_MAX_PENDING,
  AI_PROVIDER_INTERACTIVE_BURST,
  AI_PROVIDER_MAX_CONCURRENT,
  AI_PROVIDER_MAX_PENDING,
} from "../consts/aiChat/provider";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { PrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { AgentDeploymentConfig } from "../types/config";
import type { AiProviderQuotaLane } from "../types/aiChat/providerScheduler";

/** 配额归属标识：供应商协议、端点与凭据。 */
type QuotaLaneIdentity = Pick<AiProviderQuotaLane, "provider" | "baseUrl" | "apiKey">;

/**
 * 判断 lane 与配置是否具有相同的供应商协议、端点与凭据。
 * @param lane 已注册的配额 lane 条目。
 * @param config 待比对的配额归属标识。
 * @returns 供应商、自定义端点与 API Key 均相等时返回 `true`，否则返回 `false`。
 */
function isQuotaLaneOf(lane: AiProviderQuotaLane, config: QuotaLaneIdentity): boolean {
  return lane.provider === config.provider &&
    lane.baseUrl === config.baseUrl &&
    lane.apiKey === config.apiKey;
}

/**
 * 获取或创建指定配置所属配额 lane 的执行器。
 * @param config 能力配置的配额归属标识。
 * @returns 复用或新创建的优先级有界任务执行器。
 */
export function quotaRunnerFor(config: QuotaLaneIdentity): PrioritizedBoundedTaskRunner {
  for (const lane of aiProviderQuotaLanes) {
    if (isQuotaLaneOf(lane, config)) return lane.runner;
  }
  const lane: AiProviderQuotaLane = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: AI_PROVIDER_MAX_CONCURRENT,
      maxPending: AI_PROVIDER_MAX_PENDING,
      maxBackgroundPending: AI_PROVIDER_BACKGROUND_MAX_PENDING,
      interactiveBurst: AI_PROVIDER_INTERACTIVE_BURST,
    }),
  };
  aiProviderQuotaLanes.push(lane);
  return lane.runner;
}

/**
 * 判断 lane 是否仍被新配置快照的任一能力引用。
 * @param lane 待检查的配额 lane 条目。
 * @param config 新一轮的完整 agent 部署配置快照。
 * @returns 至少被一项已配置能力引用时返回 `true`，否则返回 `false`。
 */
function isQuotaLaneInUse(lane: AiProviderQuotaLane, config: AgentDeploymentConfig): boolean {
  return isQuotaLaneOf(lane, config.text) ||
    isQuotaLaneOf(lane, config.summary) ||
    isQuotaLaneOf(lane, config.media) ||
    (config.image !== undefined && isQuotaLaneOf(lane, config.image)) ||
    (config.tts !== undefined && isQuotaLaneOf(lane, config.tts)) ||
    (config.webSearch !== undefined && isQuotaLaneOf(lane, config.webSearch));
}

/**
 * 原地移除新配置快照中不再被任何能力引用的配额 lane。
 * @param config 热重载后的完整 agent 部署配置快照。
 */
export function pruneQuotaLanes(config: AgentDeploymentConfig): void {
  let kept: number = 0;
  for (const lane of aiProviderQuotaLanes) {
    if (isQuotaLaneInUse(lane, config)) aiProviderQuotaLanes[kept++] = lane;
  }
  aiProviderQuotaLanes.length = kept;
}
