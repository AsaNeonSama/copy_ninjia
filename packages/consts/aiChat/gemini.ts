/**
 * Gemini 实现包（packages/workers/aiChat/gemini/）独占的常量：请求超时与 SDK 重试次数、
 * 采样温度与输出 token 上限、生图分辨率、内容过滤与工具配置、语音合成参数与日志调用名。
 * 所属模块：packages/workers/aiChat/gemini/。
 */

import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { SafetySetting } from "@google/genai";
import type { AgentCapability } from "../../types/config";

/** 生图请求固定的分辨率档位。 */
export const GEMINI_IMAGE_SIZE: string = "1K";

/** `base_url` 缺省时传给 Google GenAI SDK 的官方默认端点根地址（与 SDK 内置缺省逐字相同，保留末尾斜杠）。所属模块：workers/aiChat/gemini/client.ts、workers/antiRaid/adDetect/ai/google.ts、workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const GEMINI_API_BASE_URL: string = "https://generativelanguage.googleapis.com/";

/** 传给 Google GenAI SDK 的固定 API 版本，显式经 `httpOptions.apiVersion` 传入以隔离 `GOOGLE_GENAI_API_VERSION` 环境变量并统一走 `v1beta` 端点（含 `generateContent`、Interactions 与 Decisions）。所属模块：workers/aiChat/gemini/client.ts、workers/antiRaid/adDetect/ai/google.ts、workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const GEMINI_API_VERSION: string = "v1beta";

/**
 * 闲聊回复生成温度，仅 Gemini 使用；OpenAI 侧不发送温度参数
 * （见 consts/aiChat/openai.ts 的模块头注）。
 */
export const GEMINI_REPLY_TEMPERATURE: number = 1.0;
/** 本轮已观测到服务端搜索后，后续工具轮改用的温度；搜索与首次成文发生在
 *  同一次请求里，那一轮仍按 GEMINI_REPLY_TEMPERATURE 生成。 */
export const GEMINI_GROUNDED_REPLY_TEMPERATURE: number = 0.7;
/** 冷消息压缩与贴纸整包简介共用的总结温度。 */
export const GEMINI_SUMMARY_TEMPERATURE: number = 0.5;

/**
 * 各流水线的输出 token 上限，均为供应商能力（换模型需重新估算）。产出实际长度
 * 由领域侧字符上限（SUMMARY_MAX_CHARS 等）约束。回复这一档包含思考 token。
 */
export const GEMINI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限。 */
export const GEMINI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/** 贴纸整包简介请求的输出 token 上限。 */
export const GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4_096;
/** 单次媒体描述请求的输出 token 上限。 */
export const GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 8_192;
/**
 * 单次语音转写请求的输出 token 上限，高于媒体描述档。
 */
export const GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS: number = 16_384;
/** text 能力结构化 JSON 生成（workers/aiChat/gemini/text.ts 的 generateGeminiJson）的输出 token 上限（含思考 token）。 */
export const GEMINI_JSON_MAX_TOKENS: number = 16_384;
/** 联网检索执行器（workers/aiChat/gemini/search.ts）单次请求的输出 token 上限（含思考 token）。 */
export const GEMINI_WEB_SEARCH_MAX_TOKENS: number = 16_384;
/** 联网检索执行器在错误日志里的调用名。所属模块：workers/aiChat/gemini/search.ts。 */
export const GEMINI_WEB_SEARCH_ERROR_LABEL: string = "Gemini web search";

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const GEMINI_REPLY_ERROR_LABEL: string = "Gemini API";
/** 生图请求在错误日志里的调用名。 */
export const GEMINI_IMAGE_ERROR_LABEL: string = "Gemini image generation API";
/** 语音合成请求在错误日志里的调用名。 */
export const GEMINI_SPEECH_ERROR_LABEL: string = "Gemini speech synthesis API";

/**
 * 单次语音合成请求的总超时。语音合成走 Interactions API，SDK 只继承构造期的
 * `httpOptions.timeout`，因此这一档在每次调用时显式传入（见 workers/aiChat/gemini/speech.ts）。
 */
export const GEMINI_SPEECH_REQUEST_TIMEOUT_MS: number = 60_000;

/** 语音合成请求的总尝试次数（含首次）；SDK 只对 408/429/5xx 与网络错误重试。 */
export const GEMINI_SPEECH_REQUEST_ATTEMPTS: number = 3;

/** 语音合成的采样温度，经 `generation_config.temperature` 传入。 */
export const GEMINI_SPEECH_TEMPERATURE: number = 1;

/**
 * 按能力取 SDK 每次尝试的超时上限，requestGeminiResult 同时以它作整次调用的 deadline。
 * 语音合成由 workers/aiChat/gemini/speech.ts 在每次调用上另行覆盖（GEMINI_SPEECH_REQUEST_TIMEOUT_MS）。
 * 所属模块：workers/aiChat/gemini/client.ts。
 */
export const GEMINI_REQUEST_TIMEOUTS_MS: Readonly<Record<AgentCapability, number>> = {
  text: 180_000,
  summary: 180_000,
  media: 240_000,
  image: 180_000,
  tts: 180_000,
  web_search: 180_000,
};
/**
 * Gemini SDK 对 408/429/5xx 的总尝试次数（含首次）；显式传入才能
 * 启用 SDK 的 retryOptions，所有调用方不得再重试这类请求失败。
 */
export const GEMINI_REQUEST_RETRY_ATTEMPTS: number = 6;

/**
 * 所有 Gemini 请求统一携带的内容过滤设置；应用不按可调概率等级主动拒绝，
 * 仍受 API 不可关闭的核心安全策略约束。
 */
export const GEMINI_SAFETY_SETTINGS: readonly Readonly<SafetySetting>[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * 服务端检索工具与函数调用混用时必须携带的 toolConfig
 * （`tool_config.include_server_side_tool_invocations`）；开启检索时直接填进请求 config（所属模块：workers/aiChat/gemini/replySession.ts）。
 */
export const GEMINI_SERVER_TOOL_CONFIG: Readonly<{ includeServerSideToolInvocations: true }> = {
  includeServerSideToolInvocations: true,
};
