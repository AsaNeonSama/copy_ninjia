/** ad_detect 按配置选择 Google、OpenAI 兼容或 Anthropic 传输，不做运行时故障切换。 */

import { getAdDetectAgentConfig } from "../../../../config/agent";
import { requestAnthropicAdDetectJson } from "./anthropic";
import { requestGoogleAdDetectJson } from "./google";
import { classifyWithGoogleDecision } from "./googleDecision";
import type { GoogleAdDetectDecisionParams } from "./googleDecision";
import { requestOpenAiAdDetectJson } from "./openai";
import type {
  AdDetectJsonRequestParams,
  AdDetectProviderResult,
  AdVerdict,
} from "../../../../types/antiRaid/adDetect";
import type { AgentProvider } from "../../../../types/config";

/** 单个模型提供商的广告检测结构化 JSON 请求函数签名。 */
type AdDetectRequest = (params: AdDetectJsonRequestParams) => Promise<AdDetectProviderResult>;

/** provider 到广告检测传输的穷举映射；扩展 AgentProvider 时编译器会要求补项。 */
const AD_DETECT_PROVIDERS: Readonly<Record<AgentProvider, AdDetectRequest>> = {
  google: requestGoogleAdDetectJson,
  openai: requestOpenAiAdDetectJson,
  anthropic: requestAnthropicAdDetectJson,
};

/**
 * 按 `ad_detect.provider` 发起一次结构化判定请求。
 * @param params 结构化广告判定请求参数。
 * @returns 传输层统一结果（成功正文、明确不支持视觉输入或失败）。
 */
export function requestAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<AdDetectProviderResult> {
  return AD_DETECT_PROVIDERS[getAdDetectAgentConfig().provider](params);
}

/**
 * 经 Google Decisions API 发起一次广告判定请求。
 * @param params Google Decisions API 判定请求参数。
 * @returns 广告判定结果；请求失败或响应不可信时返回 null。
 */
export function requestAdDetectDecision(
  params: GoogleAdDetectDecisionParams
): Promise<AdVerdict | null> {
  return classifyWithGoogleDecision(params);
}
