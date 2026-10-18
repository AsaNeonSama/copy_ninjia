/** owner: workers/aiChat。AI 闲聊 OpenAI 客户端缓存。 */

import type OpenAI from "openai";
import type { AgentCapability } from "../../../types/config";

/**
 * 按能力索引的 OpenAI 客户端实例缓存。
 * 填充：aiChat/openai/client.ts 在各能力首次请求时创建写入。
 * 清理：配置重载时由 aiChat/provider.ts 的 reloadAgentDeploymentConfig 置空，进程退出或 isolate 销毁时释放。
 * 重建：Worker 崩溃重启后从 null 按需重建。
 * 容量：单实例 holder，内层至多为 AgentCapability 枚举项数，不设淘汰。
 */
export const openAiClientCache: { current: Map<AgentCapability, OpenAI> | null } = { current: null };
