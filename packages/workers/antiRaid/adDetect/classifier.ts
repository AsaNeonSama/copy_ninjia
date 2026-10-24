/**
 * 广告判定领域逻辑：组装判定提示词（见 config/adSamples.ts 与 consts/antiRaid/adDetect.ts）、
 * 调用传输层（./ai/provider.ts）并将模型响应解析为 AdVerdict。
 * 请求失败、超时或响应形态不符时统一返回 null。
 */

import { requestAdDetectJson } from "./ai/provider";
import { adDetectPrompts } from "../../../cache/workers/antiRaid/adDetect";
import { getAdSampleConfig } from "../../../config/adSamples";
import { logger } from "../../../infra/logger";
import {
  AD_DETECT_MAX_OUTPUT_TOKENS,
  AD_DETECT_REASON_MAX_CHARS,
  AD_DETECT_TEMPERATURE,
  adDetectFact,
  buildAdDetectInstructions,
} from "../../../consts/antiRaid/adDetect";
import { isPlainRecord } from "../../../libs/record";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type { AdDetectPrompts, AdVerdict } from "../../../types/antiRaid/adDetect";
import { getAdDetectAgentConfig } from "../../../config/agent";

/**
 * 解析模型返回的 JSON 文本为 AdVerdict；格式或字段类型非法时返回 null。
 * @param raw 模型返回的原始字符串。
 * @returns 解析出的广告判定结果；输入非合法判定 JSON 时返回 null。
 */
export function parseAdVerdict(raw: string | null | undefined): AdVerdict | null {
  if (typeof raw !== "string") return null;
  const trimmed: string = raw.trim();
  const fenced: RegExpExecArray | null = trimmed.startsWith("{") && trimmed.endsWith("}")
    ? null
    : /(?:^|[\r\n])[ \t]*```json[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[ \t]*```(?=[ \t]*(?:[\r\n]|$))/i.exec(trimmed);
  const normalized: string = fenced?.[1]?.trim() ?? trimmed;
  const start: number = normalized.indexOf("{");
  const end: number = normalized.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.slice(start, end + 1)) as unknown;
  } catch (error: unknown) {
    logger.error("Ad detection response was not valid JSON:", error);
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  const verdict: Record<string, unknown> = parsed;
  // ad 字段仅接受布尔类型，非布尔值一律视为无效响应。
  if (typeof verdict.ad !== "boolean") return null;
  const reason: string = typeof verdict.reason === "string"
    ? truncateInline(sanitizeInline(verdict.reason), AD_DETECT_REASON_MAX_CHARS)
    : "";
  return { isAd: verdict.ad, reason };
}

export interface ClassifyAdTextParams {
  /** 按行编号的待判定消息串（见 adDetect/queue.ts）。 */
  text: string;
  /** 发送者是否仍处于入群验证窗口内。 */
  justJoined: boolean;
}

/**
 * 获取或构建当前示例快照对应的判定提示词缓存（见 cache/workers/antiRaid/adDetect.ts）。
 * @returns 当前生效的广告判定提示词集合。
 */
function currentAdDetectPrompts(): AdDetectPrompts {
  if (adDetectPrompts.current !== null) return adDetectPrompts.current;
  const instructions: string = buildAdDetectInstructions(getAdSampleConfig());
  const prompts: AdDetectPrompts = {
    instructions,
    justJoinedSystemPrompt: `${instructions}\n${adDetectFact(true)}`,
    establishedSystemPrompt: `${instructions}\n${adDetectFact(false)}`,
  };
  adDetectPrompts.current = prompts;
  return prompts;
}

/**
 * 判定一串消息是不是广告。
 * @param params 待判定消息串及新入群标记。
 * @returns 判定结果；请求或解析失败时为 null，调用方应视为「本次没判定」。
 */
export async function classifyAdText({ text, justJoined }: ClassifyAdTextParams): Promise<AdVerdict | null> {
  const prompts: AdDetectPrompts = currentAdDetectPrompts();
  return parseAdVerdict(await requestAdDetectJson({
    model: getAdDetectAgentConfig().model,
    instructions: prompts.instructions,
    // 系统事实与正文分开交给传输，不拼进用户可控的正文。
    fact: adDetectFact(justJoined),
    systemPrompt: justJoined ? prompts.justJoinedSystemPrompt : prompts.establishedSystemPrompt,
    userContent: text,
    temperature: AD_DETECT_TEMPERATURE,
    maxOutputTokens: AD_DETECT_MAX_OUTPUT_TOKENS,
    errorLabel: "Ad detection request",
  }));
}
