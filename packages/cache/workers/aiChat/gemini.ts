/** owner: workers/aiChat。Google GenAI 客户端按能力缓存（packages/aiChat/gemini/client.ts）。 */

import type { GoogleGenAI } from "@google/genai";
import type { AgentCapability } from "../../../types/config";

/**
 * 能力名（AgentCapability）到 GoogleGenAI 客户端实例的映射 holder：首次按能力调用时填充，agent.json 热重载时由 reloadAgentDeploymentConfig 置为 null（下次请求重建），isolate 销毁时释放。
 * 容量上限为 AgentCapability 枚举数，不淘汰；Worker 重建后从 null 重新创建。
 */
export const geminiClientCache: { current: Map<AgentCapability, GoogleGenAI> | null } = { current: null };
