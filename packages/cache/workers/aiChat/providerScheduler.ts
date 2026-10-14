/** owner: workers/aiChat。AI 模型请求配额队列与能力门面缓存（packages/aiChat/provider.ts）。 */

import type { AiProviderFacadeCache, AiProviderQuotaLane } from "../../../types/aiChat/providerScheduler";

/**
 * 按协议、端点与凭据建立的配额 lane 列表。
 * 填充：首次构造能力门面或热重载配置时按需追加。
 * 清理：reloadAgentDeploymentConfig 剔除不再引用的 lane，resetAiProviderSchedulerCache 清空。
 * 重建：Worker 崩溃重启后从空数组按需重建。
 * 容量：不超过 AgentCapability 能力项数；单条 lane 的并发与等待上限见 consts/aiChat/provider.ts。
 */
export const aiProviderQuotaLanes: AiProviderQuotaLane[] = [];

/**
 * 各项能力的稳定门面缓存。
 * 填充：能力门面首次读取时写入；清理：reloadAgentDeploymentConfig 与 resetAiProviderFacades 置空；重建：Worker 重启后从空门面按需重建；容量：固定为 AgentCapability 字段集合。
 */
export const aiProviderFacades: AiProviderFacadeCache = {
  text: undefined,
  summary: undefined,
  media: undefined,
  mediaBackground: undefined,
  image: undefined,
  tts: undefined,
  webSearch: undefined,
  textWebSearch: undefined,
  structuredText: undefined,
};

/** 清空全部能力门面缓存，下次读取时按当前配置重建。 */
export function resetAiProviderFacades(): void {
  aiProviderFacades.text = undefined;
  aiProviderFacades.summary = undefined;
  aiProviderFacades.media = undefined;
  aiProviderFacades.mediaBackground = undefined;
  aiProviderFacades.image = undefined;
  aiProviderFacades.tts = undefined;
  aiProviderFacades.webSearch = undefined;
  aiProviderFacades.textWebSearch = undefined;
  aiProviderFacades.structuredText = undefined;
}

/** 清空全部配额 lane 与能力门面缓存。 */
export function resetAiProviderSchedulerCache(): void {
  aiProviderQuotaLanes.length = 0;
  resetAiProviderFacades();
}
