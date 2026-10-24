/**
 * `config/dynamic/agent.json` 中单项 AI 能力的严格解码（纯函数，不读盘、不接触缓存）：
 * - 通用字段：`provider`（`google`、`openai` 或 `anthropic`，其中 `image` 与 `tts` 仅支持 `google` 和 `openai`）、`api_key`、`base_url`、`model`。
 * - 提供商可选字段：`anthropic` 支持 `fallback_model`。
 * - 能力专属字段：`image` 包含 `image_protocol` 与 `max_reference_images`；`web_search` 包含 `max_calls_per_use`。
 * - `tts` 能力解码位于 `config/agentTts.ts`，文件级加载、分段快照与 holder 位于 `config/agent.ts`。
 * - 报错只输出文件路径、字段路径与期望形态，不回显配置值。
 */

import {
  LOOPBACK_HOSTS,
  EXPECTED_AGENT_FALLBACK_MODEL,
  EXPECTED_BASE_URL,
  AGENT_API_KEY_PLACEHOLDERS,
  WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE,
  isAgentProvider,
} from "../consts/agent";
import {
  IMAGE_GENERATION_DEFAULT_REFERENCE_IMAGES,
  IMAGE_GENERATION_MAX_REFERENCE_IMAGES,
} from "../consts/aiChat/imageGeneration";
import { invalidInput, requiredString } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type {
  AgentCapabilityConfig,
  AgentImageCapabilityConfig,
  AgentProvider,
  AgentWebSearchCapabilityConfig,
  OpenAiImageProtocol,
} from "../types/config";

/**
 * 解码必填凭据；示例占位串存在时必须在启动阶段拒绝。
 * @param value 待校验的 `api_key` 字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 非空且非占位串的 API 密钥。
 */
export function requiredApiKey(value: unknown, context: string, sourcePath: string): string {
  const apiKey: string = requiredString(value, context, sourcePath);
  if (AGENT_API_KEY_PLACEHOLDERS.includes(apiKey)) {
    return invalidInput(sourcePath, context, "a configured non-placeholder string");
  }
  return apiKey;
}

/**
 * 解码可选的绝对端点；缺省交给对应 SDK 的官方地址。
 * 只接受 HTTPS 或 LOOPBACK_HOSTS 内的明文 HTTP，且不得含 userinfo 或 fragment。
 * @param value 待校验的 `base_url` 字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 去空白后的合法 URL 字符串；字段缺省时返回 undefined。
 */
export function optionalBaseUrl(value: unknown, context: string, sourcePath: string): string | undefined {
  if (value === undefined) return undefined;
  const raw: string = requiredString(value, context, sourcePath);
  const parsed: URL | null = URL.parse(raw);
  if (parsed === null || parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
    return invalidInput(sourcePath, context, EXPECTED_BASE_URL);
  }
  if (parsed.protocol === "https:") return raw;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname)) return raw;
  return invalidInput(sourcePath, context, EXPECTED_BASE_URL);
}

/**
 * 解码 provider；Gemini 是模型家族名，对外协议名统一为 google。
 * @param value 待校验的 `provider` 字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已校验的模型协议提供商名称。
 */
function requiredProvider(value: unknown, context: string, sourcePath: string): AgentProvider {
  const provider: string = typeof value === "string" ? value.trim() : "";
  if (isAgentProvider(provider)) return provider;
  return invalidInput(sourcePath, context, '"google", "openai" or "anthropic"');
}

/**
 * 解码生图与语音合成的 provider：这两项只有 google 与 openai 的实现，anthropic 一律拒绝。
 * @param value 待校验的 `provider` 字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns `"google"` 或 `"openai"`。
 */
export function requiredMediaProvider(value: unknown, context: string, sourcePath: string): "google" | "openai" {
  const provider: string = typeof value === "string" ? value.trim() : "";
  if (provider === "google" || provider === "openai") return provider;
  return invalidInput(sourcePath, context, '"google" or "openai"');
}

/**
 * 解码 OpenAI 兼容生图协议。
 * @param value 待校验的 `image_protocol` 字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已校验的 OpenAI 生图线协议标识。
 */
function requiredImageProtocol(
  value: unknown,
  context: string,
  sourcePath: string
): OpenAiImageProtocol {
  const protocol: string = typeof value === "string" ? value.trim() : "";
  if (protocol === "openai" || protocol === "openai-standard" || protocol === "xai") return protocol;
  return invalidInput(sourcePath, context, '"openai", "openai-standard", or "xai"');
}

/**
 * 某个 provider 下一项能力允许的全部字段：通用字段、anthropic 的 fallback_model，再加能力自己的字段。
 * @param provider 当前能力所选的协议提供商。
 * @param extraKeys 该能力特有的附加字段名列表。
 * @returns 允许出现在该能力配置对象中的字段名列表。
 */
export function capabilityKeys(provider: AgentProvider, extraKeys: readonly string[]): readonly string[] {
  if (provider === "anthropic") return ["provider", "api_key", "base_url", "model", "fallback_model", ...extraKeys];
  return ["provider", "api_key", "base_url", "model", ...extraKeys];
}

/**
 * 字段集不符时的期望形态；extraShape 是能力自己的字段，以 `, ` 开头或为空串。
 * @param provider 当前能力所选的协议提供商。
 * @param extraShape 附加字段在报错文案中的描述后缀。
 * @returns 用于错误报告的期望对象形态文本。
 */
export function capabilityShape(provider: AgentProvider, extraShape: string): string {
  const fallbackModel: string = provider === "anthropic" ? ", fallback_model?" : "";
  return `exactly { provider, api_key, base_url?, model${fallbackModel}${extraShape} } when provider is ${provider}`;
}

/** Anthropic 可选备选模型字段的解码与校验参数。 */
interface OptionalFallbackModelOptions {
  /** 待校验的 `fallback_model` 字段值。 */
  readonly value: unknown;
  /** 同一能力已解出的 model。 */
  readonly model: string;
  /** 字段 JSONPath，用于构造致命错误诊断。 */
  readonly context: string;
  /** 配置文件路径，用于构造致命错误诊断。 */
  readonly sourcePath: string;
}

/**
 * 解码 anthropic provider 可选的 fallback_model：存在时去掉首尾空白后非空，且与 model 不同。
 * @param options 待校验的备选模型值、主模型名与错误诊断路径。
 * @returns 校验通过的备选模型名；字段缺省时返回 undefined。
 */
function optionalFallbackModel({ value, model, context, sourcePath }: OptionalFallbackModelOptions): string | undefined {
  if (value === undefined) return undefined;
  const fallbackModel: string = typeof value === "string" ? value.trim() : "";
  if (fallbackModel.length === 0 || fallbackModel === model) {
    return invalidInput(sourcePath, context, EXPECTED_AGENT_FALLBACK_MODEL);
  }
  return fallbackModel;
}

/**
 * 解码通用字段；调用方须先按 capabilityKeys 核对过字段集。anthropic 分支另解 fallback_model。
 * @param value 已确认为普通对象的能力配置记录。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已校验的通用能力配置。
 */
export function parseCapabilityFields(
  value: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  const provider: AgentProvider = requiredProvider(value.provider, `${context}.provider`, sourcePath);
  const apiKey: string = requiredApiKey(value.api_key, `${context}.api_key`, sourcePath);
  const baseUrl: string | undefined = optionalBaseUrl(value.base_url, `${context}.base_url`, sourcePath);
  const model: string = requiredString(value.model, `${context}.model`, sourcePath);
  if (provider !== "anthropic") return { provider, apiKey, baseUrl, model };
  const fallbackModel: string | undefined =
    optionalFallbackModel({ value: value.fallback_model, model, context: `${context}.fallback_model`, sourcePath });
  return { provider, apiKey, baseUrl, model, fallbackModel };
}

/**
 * 能力值必须是普通对象；字段集由调用方在解出 provider 后按 capabilityKeys 核对。
 * @param value 待校验的能力字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 确认为普通对象后的只读记录。
 */
export function capabilityRecord(
  value: unknown,
  context: string,
  sourcePath: string
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) return invalidInput(sourcePath, context, "an object");
  return value;
}

/**
 * 解码一项普通能力；通用字段之外的拼写错误一律拒绝。
 * @param value 待校验的能力字段值。
 * @param context 字段 JSONPath，用于构造致命错误诊断。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的通用能力配置。
 */
export function parseCapability(
  value: unknown,
  context: string,
  sourcePath: string
): AgentCapabilityConfig {
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  if (!hasOnlyKeys(record, capabilityKeys(provider, []))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, ""));
  }
  return parseCapabilityFields(record, context, sourcePath);
}

/**
 * 解码独立联网检索能力；max_calls_per_use 缺省补齐，存在时必须是正安全整数。
 * @param value 待校验的 `$.agent.web_search` 字段值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的联网检索能力配置。
 */
export function parseWebSearchCapability(value: unknown, sourcePath: string): AgentWebSearchCapabilityConfig {
  const context: string = "$.agent.web_search";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: AgentProvider = requiredProvider(record.provider, `${context}.provider`, sourcePath);
  if (!hasOnlyKeys(record, capabilityKeys(provider, ["max_calls_per_use"]))) {
    return invalidInput(sourcePath, context, capabilityShape(provider, ", max_calls_per_use?"));
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  const maxCallsPerUse: number = optionalQuotaInteger({
    value: record.max_calls_per_use,
    context: `${context}.max_calls_per_use`,
    sourcePath,
    fallback: WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE,
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    expected: "a positive safe integer",
  });
  return { ...fields, maxCallsPerUse };
}

/**
 * 解码生图能力；只有 OpenAI 协议分支接受并要求 image_protocol，anthropic 不受理。两个分支都接受
 * 可选的 max_reference_images：缺省补 IMAGE_GENERATION_DEFAULT_REFERENCE_IMAGES，存在时必须是
 * 不超过 IMAGE_GENERATION_MAX_REFERENCE_IMAGES 的正整数。
 * @param value 待校验的 `$.agent.image` 字段值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的生图能力配置。
 */
export function parseImageCapability(
  value: unknown,
  sourcePath: string
): AgentImageCapabilityConfig {
  const context: string = "$.agent.image";
  const record: Readonly<Record<string, unknown>> = capabilityRecord(value, context, sourcePath);
  const provider: "google" | "openai" = requiredMediaProvider(record.provider, `${context}.provider`, sourcePath);
  const extraKeys: readonly string[] = provider === "openai"
    ? ["image_protocol", "max_reference_images"]
    : ["max_reference_images"];
  if (!hasOnlyKeys(record, capabilityKeys(provider, extraKeys))) {
    return invalidInput(
      sourcePath,
      context,
      capabilityShape(provider, provider === "openai" ? ", image_protocol, max_reference_images?" : ", max_reference_images?")
    );
  }
  const fields: AgentCapabilityConfig = parseCapabilityFields(record, context, sourcePath);
  if (fields.provider === "google") {
    return { ...fields, imageProtocol: undefined, maxReferenceImages: optionalMaxReferenceImages(record, context, sourcePath) };
  }
  if (fields.provider === "anthropic") return invalidInput(sourcePath, `${context}.provider`, '"google" or "openai"');
  return {
    ...fields,
    imageProtocol: requiredImageProtocol(record.image_protocol, `${context}.image_protocol`, sourcePath),
    maxReferenceImages: optionalMaxReferenceImages(record, context, sourcePath),
  };
}

/**
 * 解码生图能力可选的 max_reference_images；context 是 image 能力自身的字段路径。
 * @param record 生图能力配置对象记录。
 * @param context 生图能力字段的 JSONPath。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 单次生图允许携带的最大参考图张数。
 */
function optionalMaxReferenceImages(
  record: Readonly<Record<string, unknown>>,
  context: string,
  sourcePath: string
): number {
  return optionalQuotaInteger({
    value: record.max_reference_images,
    context: `${context}.max_reference_images`,
    sourcePath,
    fallback: IMAGE_GENERATION_DEFAULT_REFERENCE_IMAGES,
    min: 1,
    max: IMAGE_GENERATION_MAX_REFERENCE_IMAGES,
    expected: `an integer from 1 to ${IMAGE_GENERATION_MAX_REFERENCE_IMAGES}`,
  });
}

/** 可选整数配额字段的范围校验与缺省回退参数。 */
export interface QuotaIntegerOptions {
  /** 待校验的原始整数字段值。 */
  readonly value: unknown;
  /** 字段 JSONPath，用于构造致命错误诊断。 */
  readonly context: string;
  /** 配置文件路径，用于构造致命错误诊断。 */
  readonly sourcePath: string;
  /** 字段缺省时采用的回退整数值。 */
  readonly fallback: number;
  /** 允许的最小整数值（含）。 */
  readonly min: number;
  /** 允许的最大整数值（含）。 */
  readonly max: number;
  /** 错误信息里的期望形态，不含配置值。 */
  readonly expected: string;
}

/**
 * 解码语音每日额度、检索调用上限或生图参考图张数的整数字段：存在时必须是 min～max 的安全整数；
 * 缺省时取 fallback，fallback 落在区间外同样按 expected 拒绝。
 * @param options 待校验的字段值、边界范围、缺省值及错误诊断上下文。
 * @returns 落在 `[min, max]` 区间内的安全整数。
 */
export function optionalQuotaInteger({ value, context, sourcePath, fallback, min, max, expected }: QuotaIntegerOptions): number {
  if (value === undefined) {
    if (fallback >= min && fallback <= max) return fallback;
    return invalidInput(sourcePath, context, expected);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalidInput(sourcePath, context, expected);
  }
  return value;
}
