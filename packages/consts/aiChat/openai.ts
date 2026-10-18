/**
 * OpenAI 实现包（packages/aiChat/openai/）独占的常量：token 上限、请求超时、
 * SDK 重试次数、画幅表、语音合成两种线协议的参数与请求参数档位。
 * 所属模块：packages/aiChat/openai/。
 */

import type OpenAI from "openai";
import type { ImageGenerationAspectRatio } from "../../types/aiChat/imageGeneration";
import type { AgentCapability } from "../../types/config";

/** OpenAI SDK images generate/edit 共用的尺寸参数。 */
type OpenAiImageSize = NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["size"]>;

/**
 * 各流水线的输出 token 上限（含推理 token）。
 */
export const OPENAI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限（含推理 token）。 */
export const OPENAI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/**
 * 贴纸整包简介请求的输出 token 上限（含推理 token）。
 */
export const OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 16_384;
/** 单次媒体描述请求的输出 token 上限（含推理 token）。 */
export const OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 16_384;
/** text 能力结构化 JSON 生成（aiChat/openai/text.ts 的 generateOpenAiJson）的输出 token 上限（含推理 token）。 */
export const OPENAI_JSON_MAX_TOKENS: number = 16_384;
/** 联网检索执行器（aiChat/openai/search.ts）单次请求的输出 token 上限（含推理 token）。 */
export const OPENAI_WEB_SEARCH_MAX_TOKENS: number = 16_384;
/** 联网检索执行器在错误日志里的调用名。所属模块：aiChat/openai/search.ts。 */
export const OPENAI_WEB_SEARCH_ERROR_LABEL: string = "OpenAI web search";

/**
 * `prompt_cache_key` 的命名空间前缀（见 aiChat/openai/replySession.ts）。
 */
export const OPENAI_PROMPT_CACHE_KEY_PREFIX: string = "hunhebi-reply";

/**
 * Responses API 接受的 `prompt_cache_key` 最大字符长度（见 libs/prefixFingerprint.ts）。
 */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH: number = 64;

/**
 * 支持显式 prompt cache breakpoint 的 OpenAI 官方模型族前缀（见 aiChat/openai/replySession.ts）。
 */
export const OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX: string = "gpt-5.6";

type OpenAiPromptCacheTtl = NonNullable<
  NonNullable<
    OpenAI.Responses.ResponseCreateParamsNonStreaming["prompt_cache_options"]
  >["ttl"]
>;

/** prompt cache breakpoint 使用的存活时间。 */
export const OPENAI_PROMPT_CACHE_TTL: OpenAiPromptCacheTtl = "30m";

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const OPENAI_REPLY_ERROR_LABEL: string = "OpenAI API";
/** 生图请求在错误日志里的调用名。 */
export const OPENAI_IMAGE_ERROR_LABEL: string = "OpenAI image generation API";

/**
 * 生图请求在每次请求上覆盖的独立超时，不套用 OPENAI_REQUEST_TIMEOUTS_MS 的预算。
 */
export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS: number = 300_000;
/**
 * 按能力取 SDK 每次尝试的超时上限，requestOpenAiResult 同时以它作整次调用的 deadline。
 * image 与 tts 分别由 aiChat/openai/image.ts 与 aiChat/openai/speech.ts 在每次请求上另行覆盖。
 * 所属模块：aiChat/openai/client.ts、aiChat/openai/text.ts。
 */
export const OPENAI_REQUEST_TIMEOUTS_MS: Readonly<Record<AgentCapability, number>> = {
  text: 180_000,
  summary: 180_000,
  media: 240_000,
  image: 180_000,
  tts: 180_000,
  web_search: 180_000,
};
/**
 * SDK 对 408/429/5xx 的重试次数（不含首次请求，语义同 OpenAI SDK 的
 * maxRetries）；所有调用方不得再重试这类请求失败。
 */
export const OPENAI_REQUEST_MAX_RETRIES: number = 5;

/**
 * OpenAI `openai` 任意尺寸生图协议各宽高比对应的请求尺寸映射表。
 */
export const OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO: Readonly<
  Record<ImageGenerationAspectRatio, OpenAiImageSize>
> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1408x1056",
  "3:4": "1056x1408",
  "5:4": "1360x1088",
  "4:5": "1088x1360",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "21:9": "1568x672",
};

/**
 * OpenAI `openai-standard` 标准尺寸生图协议各宽高比对应的请求尺寸映射表。
 */
export const OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO: Readonly<
  Record<ImageGenerationAspectRatio, OpenAiImageSize>
> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "5:4": "1536x1024",
  "4:5": "1024x1536",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "21:9": "1536x1024",
};

/**
 * xAI 生图请求显式指定的分辨率档位。所属模块：packages/aiChat/openai/image.ts。
 */
export const XAI_IMAGE_RESOLUTION: string = "1k";

/**
 * OpenAI 原生生图请求指定的输出图片格式（generate 与 edit 分支共用）。
 */
export const OPENAI_IMAGE_OUTPUT_FORMAT: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["output_format"]> = "png";

/**
 * OpenAI 原生生图 generate 分支的内容审核档位。
 */
export const OPENAI_IMAGE_MODERATION: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["moderation"]> = "low";

/** openai 语音协议（audio/speech）在错误日志里的调用名。 */
export const OPENAI_SPEECH_ERROR_LABEL: string = "OpenAI speech synthesis API";
/** xai 语音协议（`POST /tts`）在错误日志里的调用名。 */
export const XAI_SPEECH_ERROR_LABEL: string = "xAI speech synthesis API";

/**
 * 两种语音协议单次合成的总期限（含全部尝试与退避），同时是每次尝试的超时；口径同
 * consts/aiChat/gemini.ts 的 GEMINI_SPEECH_REQUEST_TIMEOUT_MS。所属模块：aiChat/openai/speech.ts
 * 与 aiChat/openai/xaiSpeech.ts。
 */
export const OPENAI_SPEECH_REQUEST_TIMEOUT_MS: number = 60_000;

/**
 * 两种语音协议的总尝试次数（含首次）。openai 协议交给 SDK 的 maxRetries（本值减一），
 * xai 协议由 aiChat/openai/xaiSpeech.ts 对网络错误与 408/429/5xx 按同一上限重试。
 */
export const OPENAI_SPEECH_REQUEST_ATTEMPTS: number = 3;

/**
 * openai 语音协议请求的音频响应格式（见 aiChat/ai/voiceEncoding.ts）。
 */
export const OPENAI_SPEECH_RESPONSE_FORMAT: NonNullable<OpenAI.Audio.SpeechCreateParams["response_format"]> = "opus";

/** xai 语音协议未配置 base_url 时使用的 xAI 官方 API 根地址。 */
export const XAI_API_BASE_URL: string = "https://api.x.ai/v1";

/** xai 语音协议相对 base_url 的端点路径。 */
export const XAI_SPEECH_ENDPOINT_PATH: string = "tts";

/** `agent.tts.language` 缺省时交给 xAI 的默认语言标识。 */
export const XAI_SPEECH_DEFAULT_LANGUAGE: string = "auto";

/**
 * xai 语音协议请求的音频编码格式（`output_format.codec`，见 aiChat/ai/voiceEncoding.ts）。
 */
export const XAI_SPEECH_CODEC: string = "mp3";

/** xai 语音协议请求的 `output_format.sample_rate`（Hz）。 */
export const XAI_SPEECH_SAMPLE_RATE: number = 24_000;

/** xai 语音协议请求的 `output_format.bit_rate`（bps）。 */
export const XAI_SPEECH_BIT_RATE: number = 64_000;

/** xai 语音协议重试前的首次退避（ms），之后每次翻倍；退避受总期限约束。 */
export const XAI_SPEECH_RETRY_BASE_DELAY_MS: number = 500;

/** xai 语音协议非 2xx 响应体读入错误日志的字节上限。 */
export const XAI_SPEECH_ERROR_BODY_MAX_BYTES: number = 1_024;

/**
 * Responses API 请求的 `store` 参数值（见 aiChat/openai/replySession.ts）。
 */
export const OPENAI_STORE_RESPONSES: boolean = false;

/** OpenAI 响应缺省 output 时复用的只读空列表。 */
export const EMPTY_OUTPUT_ITEMS: readonly [] = [];
