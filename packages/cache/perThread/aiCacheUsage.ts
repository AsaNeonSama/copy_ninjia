/** owner: perThread。AI 缓存用量上报回调与告警去重集合（packages/infra/aiCacheUsage.ts）。 */

import type { AiCacheUsage, AiUsageWarningKey } from "../../types/aiCache";

/** 当前线程的 AI 缓存用量上报函数单例：AI 闲聊 Worker 与 Anti-Raid Worker 启动时安装，停止时清空为 null；主线程保持 null，不淘汰，Worker 重建后由新 isolate 重新安装。 */
export const aiCacheUsageSink: { current: ((usage: AiCacheUsage) => void) | null } = { current: null };

/** 当前线程的 AI 用量缺失告警去重集合：首次触发某「能力 × 供应商 × 原因」组合时写入，安装或卸载 aiCacheUsageSink 时清空；容量上限为固定枚举组合数，不淘汰，Worker 重建后从空集开始。 */
export const aiUsageWarningKeys: Set<AiUsageWarningKey> = new Set();
