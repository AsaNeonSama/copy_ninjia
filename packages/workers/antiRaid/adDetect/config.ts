/**
 * 广告检测配置同步（Anti-Raid Worker 侧）：接收主线程投递的配置快照并刷新模型客户端与提示词缓存。
 */
import { adDetectPrompts } from "../../../cache/workers/antiRaid/adDetect";
import { adDetectGeminiContextCache } from "../../../cache/workers/antiRaid/geminiContextCache";
import { adDetectGoogleClientHolder } from "../../../cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../cache/workers/antiRaid/openai";
import { adDetectAnthropicClientHolder } from "../../../cache/workers/antiRaid/anthropic";
import { adoptAdDetectConfig } from "../../../config/adDetectConfig";
import { adDetectAgentConfigSnapshot, adoptAdDetectAgentConfig } from "../../../config/agent";
import { probeGeminiContextCache } from "../../../infra/geminiContextCache";
import { AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE } from "./ai/google";
import type { AntiRaidAgentConfigMessage } from "../../../types/antiRaid/protocol";

/**
 * 接管主线程投递的广告检测配置（初始化、Worker 重建与 `config/dynamic/` 热重载共用，本线程不直接读盘）：
 * - 更新 `agent.ad_detect` 快照并清空各家 SDK 客户端缓存（在途判定继续持有旧客户端直至结算）；
 * - `agent.ad_detect` 变化时重置 Gemini 显式上下文缓存登记表，若新配置选用 Google 则发起支持度探测与既有缓存扫描；
 * - `adDetectConfig` 非空时替换广告检测部署配置快照（样本与贴纸/表情黑名单）并清空提示词缓存，为 `null` 时保持原快照不动。
 *
 * @param msg 主线程发来的广告检测与群风格配置消息。
 */
export function adoptAdDetectConfigMessage(msg: AntiRaidAgentConfigMessage): void {
  const adDetectChanged: boolean = !Bun.deepEquals(adDetectAgentConfigSnapshot(), msg.adDetect);
  if (adDetectChanged) adDetectGeminiContextCache.current = null;
  adoptAdDetectAgentConfig(msg.adDetect);
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectAnthropicClientHolder.current = null;
  if (adDetectChanged && msg.adDetect?.provider === "google") {
    probeGeminiContextCache(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE);
  }
  if (msg.adDetectConfig !== null) {
    adoptAdDetectConfig(msg.adDetectConfig);
    adDetectPrompts.current = null;
  }
}
