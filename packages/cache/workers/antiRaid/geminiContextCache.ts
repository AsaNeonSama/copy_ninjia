/** owner: workers/antiRaid。广告检测 Gemini 显式上下文缓存登记表与内容指纹（packages/workers/antiRaid/adDetect/ai/google.ts）。 */

import type { GeminiContextCacheContent, GeminiContextCacheRegistry } from "../../../types/geminiContextCache";

/**
 * ad_detect 能力的 Gemini 显式缓存登记表（读写见 infra/geminiContextCache.ts）。
 * 填充：首次使用 Google 判定时创建并扫描接管服务端既有缓存，后台创建、命中或续期成功时更新槽位。
 * 清理：内容变化替换、淘汰未用接管项、超出上限淘汰最久未用槽、缓存失效或续期报缓存不存在时摘除；收到新 ad_detect 配置快照时由 workers/antiRaid/adDetect/config.ts 置空。
 * 重建：Worker 崩溃重启后从 null 开始，首次判定时重新扫描接管。
 * 容量：单张登记表，槽位上限为 AD_DETECT_GEMINI_CACHE_MAX_SLOTS。
 */
export const adDetectGeminiContextCache: { current: GeminiContextCacheRegistry | null } = { current: null };

/**
 * 当前广告判定规则与样本段的内容及指纹单槽缓存（infra/geminiContextCache.ts 的 geminiContextCacheContent）。
 * 填充：首次判定或模型、系统指令变化时计算并整槽覆盖；清理：随新值覆盖释放；重建：Worker 重启后从 null 开始；容量：固定为单个槽位。
 */
export const adDetectGeminiCacheContent: { current: GeminiContextCacheContent | null } = { current: null };
