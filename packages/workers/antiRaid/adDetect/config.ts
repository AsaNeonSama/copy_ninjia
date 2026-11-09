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
 * Anti-Raid Worker 接管主线程投递的广告检测配置（AntiRaidAgentConfigMessage）；
 * 初始化、Worker 重建与 config/dynamic/ 热重载都走这里，本线程从不读盘。
 *
 * 整体替换 holder 后丢弃按旧快照建立的各家 SDK 客户端；agent.ad_detect 有变化时同时丢弃
 * 显式缓存的登记表，并在新配置选用 Google 时启动显式缓存支持度探测与既有条目扫描。adDetectConfig
 * 非空时整体替换广告检测部署配置快照（本线程只读其中示例与贴纸/表情黑名单）并清空提示词缓存，下一次判定按新快照重建；在途判定继续持有旧客户端直至结算。adDetectConfig
 * 为 null 表示广告检测不可用，该 holder 保持不动。
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
