/**
 * config/dynamic/agent.json 里 `agent.tts` 语音合成能力的严格解码（纯函数，不读盘、不接触缓存）：
 * provider（仅 google 与 openai，拒绝 anthropic）、speech_protocol、voice、style、language、
 * bot_language、daily_limit 与 daily_reserve_quota。通用能力字段辅助见 config/agentCapability.ts，
 * 文件级加载、分段快照与 holder 在 config/agent.ts。报错只写来源路径、字段路径与期望形态，不回显配置值。
 */

import {
  EXPECTED_TTS_BOT_LANGUAGE,
  TTS_DEFAULT_BOT_LANGUAGE,
  TTS_DEFAULT_DAILY_LIMIT,
  TTS_DEFAULT_DAILY_RESERVE_QUOTA,
  TTS_DEFAULT_STYLE,
  isTtsBotLanguage,
} from "../consts/aiChat/voiceMessage";
import { XAI_SPEECH_DEFAULT_LANGUAGE } from "../consts/aiChat/openai";
import { invalidInput } from "../libs/inputValidation";
import { hasOnlyKeys } from "../libs/record";
import type {
  AgentCapabilityConfig,
  AgentTtsCapabilityConfig,
  OpenAiSpeechProtocol,
  TtsBotLanguage,
} from "../types/config";
import {
  capabilityKeys,
  capabilityRecord,
  capabilityShape,
  optionalBaseUrl,
  optionalQuotaInteger,
  parseCapabilityFields,
  requiredApiKey,
  requiredMediaProvider,
  requiredString,
} from "./agentCapability";

/** 解码 OpenAI 协议下的语音合成线协议。 */
function requiredSpeechProtocol(
  value: unknown,
  context: string,
  sourcePath: string
): OpenAiSpeechProtocol {
  const protocol: string = typeof value === "string" ? value.trim() : "";
  if (protocol === "openai" || protocol === "xai") return protocol;
  return invalidInput(sourcePath, context, '"openai" or "xai"');
}

/** 解码可选的 bot_language：缺省为 TTS_DEFAULT_BOT_LANGUAGE；存在时去掉首尾空白后必须是 TTS_BOT_LANGUAGES 之一。 */
function optionalBotLanguage(value: unknown, context: string, sourcePath: string): TtsBotLanguage {
  if (value === undefined) return TTS_DEFAULT_BOT_LANGUAGE;
  const language: string = typeof value === "string" ? value.trim() : "";
  if (isTtsBotLanguage(language)) return language;
  return invalidInput(sourcePath, context, EXPECTED_TTS_BOT_LANGUAGE);
}

/** 语音合成每日额度的两个解码结果。 */
interface TtsDailyQuota {
  readonly dailyLimit: number;
  readonly dailyReserveQuota: number;
}

/**
 * 解码可选的 daily_limit 与 daily_reserve_quota。daily_limit 是正整数；daily_reserve_quota 是
 * 小于 daily_limit 的非负整数。缺省值（TTS_DEFAULT_DAILY_LIMIT、TTS_DEFAULT_DAILY_RESERVE_QUOTA）
 * 同样按这一关系核对。
 */
function parseTtsDailyQuota(
  record: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): TtsDailyQuota {
  const dailyLimit: number = optionalQuotaInteger({
    value: record.daily_limit,
    context: `${context}.daily_limit`,
    sourcePath,
    fallback: TTS_DEFAULT_DAILY_LIMIT,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    expected: "a positive integer",
  });
  const dailyReserveQuota: number = optionalQuotaInteger({
    value: record.daily_reserve_quota,
    context: `${context}.daily_reserve_quota`,
    sourcePath,
    fallback: TTS_DEFAULT_DAILY_RESERVE_QUOTA,
    min: 0,
    max: dailyLimit - 1,
    expected: `an integer from 0 to ${dailyLimit - 1} (daily_limit - 1; defaults to ${TTS_DEFAULT_DAILY_RESERVE_QUOTA} when omitted)`,
  });
  return { dailyLimit, dailyReserveQuota };
}

/**
 * 解码 xai 语音协议（`POST /tts`）的配置：端点没有模型名与风格指令，model 与 style 出现即
 * 拒绝；language 是随请求发送的合成语言，缺省为 XAI_SPEECH_DEFAULT_LANGUAGE，与只决定提示词的
 * bot_language 各自独立。调用方已解出 provider 与 speech_protocol。
 */
function parseXAiTtsCapability(
  record: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): AgentTtsCapabilityConfig {
  const keys: readonly string[] = [
    "provider", "api_key", "base_url", "speech_protocol", "voice", "language", "bot_language", "daily_limit",
    "daily_reserve_quota",
  ];
  if (!hasOnlyKeys(record, keys)) {
    return invalidInput(
      sourcePath,
      context,
      "exactly { provider, api_key, base_url?, speech_protocol, voice, language?, bot_language?, daily_limit?, " +
      "daily_reserve_quota? } when provider is openai and speech_protocol is xai"
    );
  }
  const apiKey: string = requiredApiKey(record.api_key, `${context}.api_key`, sourcePath);
  const baseUrl: string | undefined = optionalBaseUrl(record.base_url, `${context}.base_url`, sourcePath);
  const voice: string = requiredString(record.voice, `${context}.voice`, sourcePath);
  const language: string = record.language === undefined
    ? XAI_SPEECH_DEFAULT_LANGUAGE
    : requiredString(record.language, `${context}.language`, sourcePath);
  const botLanguage: TtsBotLanguage = optionalBotLanguage(record.bot_language, `${context}.bot_language`, sourcePath);
  const quota: TtsDailyQuota = parseTtsDailyQuota(record, context, sourcePath);
  return {
    provider: "openai",
    apiKey,
    baseUrl,
    headers: undefined,
    model: undefined,
    speechProtocol: "xai",
    voice,
    style: undefined,
    language,
    botLanguage,
    dailyLimit: quota.dailyLimit,
    dailyReserveQuota: quota.dailyReserveQuota,
  };
}

/**
 * 解码语音合成能力，字段集随协议而定：
 *
 * - google：通用字段（含 headers）之外必填 voice，可选 style。
 * - openai：必填 speech_protocol。取 `openai`（audio/speech）时字段同 google 但无 headers；
 *   取 `xai` 时见 parseXAiTtsCapability。
 *
 * style 缺省使用 TTS_DEFAULT_STYLE；各协议都接受可选的 bot_language（见 optionalBotLanguage）
 * 与 daily_limit、daily_reserve_quota（见 parseTtsDailyQuota）。字段集之外的键一律拒绝；
 * anthropic 不受理。
 */
export function parseTtsCapability(
  value: unknown,
  sourcePath: string
): AgentTtsCapabilityConfig {
  const context: string = "$.agent.tts";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: "google" | "openai" = requiredMediaProvider(record.provider, `${context}.provider`, sourcePath);
  if (provider === "openai") {
    const speechProtocol: OpenAiSpeechProtocol =
      requiredSpeechProtocol(record.speech_protocol, `${context}.speech_protocol`, sourcePath);
    if (speechProtocol === "xai") return parseXAiTtsCapability(record, context, sourcePath);
    if (!hasOnlyKeys(
      record,
      capabilityKeys(provider, ["speech_protocol", "voice", "style", "bot_language", "daily_limit", "daily_reserve_quota"])
    )) {
      return invalidInput(
        sourcePath,
        context,
        "exactly { provider, api_key, base_url?, model, speech_protocol, voice, style?, bot_language?, daily_limit?, " +
        "daily_reserve_quota? } when provider is openai and speech_protocol is openai"
      );
    }
  } else if (!hasOnlyKeys(record, capabilityKeys(provider, ["voice", "style", "bot_language", "daily_limit", "daily_reserve_quota"]))) {
    return invalidInput(
      sourcePath,
      context,
      capabilityShape(provider, ", voice, style?, bot_language?, daily_limit?, daily_reserve_quota?")
    );
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  const voice: string = requiredString(record.voice, `${context}.voice`, sourcePath);
  const style: string = record.style === undefined
    ? TTS_DEFAULT_STYLE
    : requiredString(record.style, `${context}.style`, sourcePath);
  const botLanguage: TtsBotLanguage = optionalBotLanguage(record.bot_language, `${context}.bot_language`, sourcePath);
  const quota: TtsDailyQuota = parseTtsDailyQuota(record, context, sourcePath);
  if (fields.provider === "google") {
    return {
      provider: "google",
      apiKey: fields.apiKey,
      baseUrl: fields.baseUrl,
      headers: fields.headers,
      model: fields.model,
      speechProtocol: undefined,
      voice,
      style,
      language: undefined,
      botLanguage,
      dailyLimit: quota.dailyLimit,
      dailyReserveQuota: quota.dailyReserveQuota,
    };
  }
  return {
    provider: "openai",
    apiKey: fields.apiKey,
    baseUrl: fields.baseUrl,
    headers: undefined,
    model: fields.model,
    speechProtocol: "openai",
    voice,
    style,
    language: undefined,
    botLanguage,
    dailyLimit: quota.dailyLimit,
    dailyReserveQuota: quota.dailyReserveQuota,
  };
}
