/** owner: workers/aiChat。Anthropic 客户端按能力缓存（packages/aiChat/anthropic/client.ts）。 */

import type { AnthropicClient } from "../../../types/aiChat/anthropic";
import type { AgentCapability } from "../../../types/config";

/**
 * 能力名（AgentCapability）到 Anthropic 客户端实例的映射 holder：首次按能力调用时填充，agent.json 热重载时由 reloadAgentDeploymentConfig 置为 null（下次请求重建），isolate 销毁时释放。
 * 容量上限为支持 Anthropic 的 AgentCapability 枚举数，不淘汰；Worker 重建后从 null 重新创建。
 */
export const anthropicClientCache: { current: Map<AgentCapability, AnthropicClient> | null } = { current: null };
