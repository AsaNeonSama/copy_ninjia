import type {
  AdBundleMediaSlice,
  CachedCustomEmojiMeta,
  ResolvedAdBundleMedia,
} from "../../../types/antiRaid/adDetect";
import type { AdBlockScope } from "../../../types/config";
import type { AdPunishmentAction } from "../../../types/states/adPunishment";
import { exhaustiveList } from "../../exhaustiveList";

/**
 * 广告检测（Google / OpenAI / Anthropic 协议）的队列、预算、超时、阈值与配置字段常量。
 * 判定流水线在入群守卫线程里执行，见 workers/antiRaid/adDetect/。
 */

/** 批处理节拍：每这么久从队首取一批待检发言者送检。 */
export const AD_DETECT_QUEUE_TICK_MS: number = 1_000;

/**
 * 单个节拍最多并发送检的发言者数（入群守卫线程跨群 FIFO 总量；在途并发另受 AD_DETECT_MAX_IN_FLIGHT 约束）。
 */
export const AD_DETECT_BATCH_SIZE: number = 25;

/**
 * 同时在途的判定请求上限（入群守卫线程跨群总量闸）。
 * 所属模块：states/adDetectAdmission.ts、workers/antiRaid/adDetect/disposal.ts 与 workers/antiRaid/adDetect/queueState.ts。
 */
export const AD_DETECT_MAX_IN_FLIGHT: number = 75;

/**
 * 处置抑制与已消费上下文的保留 TTL（只裁剪已判定条目，未判定条目不设等待 TTL）。
 */
export const AD_DETECT_JUDGED_RETENTION_WINDOW_MS: number = 90_000;

/**
 * 引用、回复或转发非白名单广告第一次命中后的升级窗口；窗口内再次命中才沿用
 * 直接广告的处罚路径（按 ad_detect.json 的处罚设置）。
 * 所属模块：states/adReferenceWarning.ts、workers/antiRaid/adDetect/referencePolicy.ts 与 workers/antiRaid/adDetect/referencedWarning.ts。
 */
export const AD_REFERENCE_WARNING_WINDOW_MS: number = 300_000;

/**
 * 已接纳的待检发送者 key 容量上限（达到上限后拒绝新 key，不淘汰已入队 key；同时作为 recentlyDisposedAdKeys 容量）。
 */
export const AD_DETECT_MAX_PENDING_SENDERS: number = 8_192;

/**
 * 单个键最多保留的完整消息条数（正文 + 样本上下文）；越界时优先丢弃已判定的旧上下文，
 * 全为未判定时丢弃最早一条并将其消息 id 转存进 AdMessageBundle.pendingDeleteIds。
 */
export const AD_DETECT_MAX_MESSAGES_PER_SENDER: number = 15;

/**
 * 单个键最多转存的已挤出上下文待删消息 id 数量；超出时丢弃最旧一条并记错误日志。
 */
export const AD_DETECT_MAX_PENDING_DELETE_IDS: number = 500;

/**
 * 单条消息**正文**参与判定的最大字符数，超出部分从尾部截断。text_link 的落地页
 * URL 不占这份额度（见 AD_DETECT_MAX_LINK_URLS 与 AD_DETECT_LINK_URL_MAX_CHARS）。
 */
export const AD_DETECT_MESSAGE_MAX_CHARS: number = 512;

/** 发言者 first_name、last_name 各自的送检上限；独立于正文配额，截断保留完整代理对。所属模块：workers/antiRaid/adDetect/senderName.ts。 */
export const AD_DETECT_SENDER_NAME_MAX_CHARS: number = 128;

/**
 * 一次送检的整串消息最大字符数（超出预算的未判条目留待下一批，见 workers/antiRaid/adDetect/bundle.ts 的 selectAdBundleEntries）。
 */
export const AD_DETECT_BUNDLE_MAX_CHARS: number = 4_096;

/**
 * 单条消息最多补进送检文本的 text_link 实体 URL 个数。
 */
export const AD_DETECT_MAX_LINK_URLS: number = 5;

/** 补进送检文本的单个 URL 最大字符数。 */
export const AD_DETECT_LINK_URL_MAX_CHARS: number = 256;

/**
 * 广告判定请求的输出 token 上限（含推理 token）。
 */
export const AD_DETECT_MAX_OUTPUT_TOKENS: number = 16_384;

/**
 * 广告检测请求的采样温度（供 AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS 空正文重采样；
 * 仅 OpenAI 兼容传输将该字段写入请求体，Anthropic 与 Google 传输省略以沿用默认采样行为）。
 */
export const AD_DETECT_TEMPERATURE: number = 0.5;

/** OpenAI 兼容广告检测每次 SDK 尝试的超时。 */
export const AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS: number = 60_000;

/** OpenAI SDK 的重试次数（不含首次）；请求异常只由 SDK 重试，业务层不重试。 */
export const AD_DETECT_OPENAI_REQUEST_MAX_RETRIES: number = 2;

/** Anthropic 广告检测每次 SDK 尝试的超时；所属模块：workers/antiRaid/adDetect/ai/anthropic.ts。 */
export const AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS: number = 60_000;

/** Anthropic SDK 的重试次数（不含首次）；所属模块：workers/antiRaid/adDetect/ai/anthropic.ts。 */
export const AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES: number = 2;

/** Google 广告检测请求每次 SDK 尝试的超时；所属模块：workers/antiRaid/adDetect/ai/google.ts 与 workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS: number = 60_000;

/** Google SDK 的总尝试次数（含首次）；所属模块：workers/antiRaid/adDetect/ai/google.ts 与 workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_GOOGLE_REQUEST_ATTEMPTS: number = 3;

/** 模型成功响应但正文不可用时的总尝试次数（含首次），三种 provider 共用；Anthropic 拒答不重采样。 */
export const AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS: number = 2;

/** 单次广告消息束送检最多附带的多模态视觉图片张数上限（覆盖照片、贴纸与自定义表情）。所属模块：workers/antiRaid/adDetect/。 */
export const AD_DETECT_MAX_IMAGES_PER_BUNDLE: number = 8;

/** Google Decisions API 判定整体消息束为广告的最低置信度概率阈值（含）。所属模块：workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_DECISION_AD_THRESHOLD: number = 0.8;

/** Google Decisions API 将单个贴纸包或自定义表情包归因为广告并自动拉黑的最低置信度概率阈值（含）。所属模块：workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_DECISION_PACK_THRESHOLD: number = 0.8;

/** 匹配以 `/<apiVersion>/decisions` 结尾的 Google Decisions 自定义端点 URL。所属模块：workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_DECISIONS_FULL_PATH_PATTERN: Readonly<RegExp> =
  /^(https?:\/\/.+)\/(v[0-9][A-Za-z0-9_-]*)\/decisions$/u;

/** 匹配以 `/<apiVersion>` 结尾的 Google Decisions 自定义端点 URL。所属模块：workers/antiRaid/adDetect/ai/googleDecision.ts。 */
export const AD_DETECT_DECISIONS_VERSION_PATH_PATTERN: Readonly<RegExp> =
  /^(https?:\/\/.+)\/(v[0-9][A-Za-z0-9_-]*)$/u;

/** 广告检测提取图片文件消息（`message.document`）时允许的 MIME 类型白名单。所属模块：libs/telegramImage.ts。 */
export const AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** config/dynamic/ad_detect.json 顶层必须精确具备的字段名列表。所属模块：config/adDetectConfig.ts。 */
export const AD_DETECT_CONFIG_KEYS: readonly string[] = [
  "punishment",
  "samples",
];

/** config/dynamic/ 下禁止存在的旧广告配置文件名，出现时拒绝启动；所属模块：config/layout.ts。 */
export const LEGACY_AD_SAMPLES_CONFIG_NAME: string = "ad_samples.json";

/**
 * ad_detect.json 的 `punishment` 允许出现的字段名：`mute` 与 `kick` 互斥，必须恰好出现其一。
 * 所属模块：config/adDetectConfig.ts。
 */
export const AD_PUNISHMENT_KEYS: readonly string[] = ["mute", "kick"];

/**
 * `punishment.mute` 允许出现的字段名：`permanent` 必填；`duration` 在 permanent 为 false 时必填、
 * 为 true 时必须缺省。所属模块：config/adDetectConfig.ts。
 */
export const AD_PUNISHMENT_MUTE_KEYS: readonly string[] = ["permanent", "duration"];

/**
 * `punishment.kick` 允许出现的字段名：`block` 必填；`block_scope` 在 block 为 true 时必填、
 * 为 false 时必须缺省。所属模块：config/adDetectConfig.ts。
 */
export const AD_PUNISHMENT_KICK_KEYS: readonly string[] = ["block", "block_scope"];

/** `punishment.kick.block_scope` 的全部合法取值。所属模块：config/adDetectConfig.ts。 */
export const AD_BLOCK_SCOPES: readonly AdBlockScope[] = exhaustiveList<AdBlockScope>()([
  "chat",
  "global",
]);

/** config/dynamic/ad_detect.json 的 samples 允许的最大条数。 */
export const MAX_CONFIGURED_AD_SAMPLES: number = 500;

/**
 * 自定义表情 ID -> 所属表情包与视觉素材元数据（CachedCustomEmojiMeta）的 LRU 缓存容量；按表情 ID 计数，同一表情包的多个表情各占一条。
 * 所属模块：cache/workers/antiRaid/adDetect.ts。
 */
export const AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX: number = 4_096;

/**
 * 单轮 `getCustomEmojiStickers` 批量查询（自定义表情黑名单快路径与多模态 `resolveCustomEmojiMetadata` 共用）
 * 失败后还能立即再试的总次数，各批共用；4xx 拒绝不重试，预算用尽、被拒或进入停机即放弃本轮查询。
 * 所属模块：workers/antiRaid/adDetect/blacklistFastPath.ts。
 */
export const AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES: number = 3;

/** 单条广告示例允许的最大字符数。 */
export const AD_SAMPLE_MAX_CHARS: number = 1_024;

/** 判定理由在日志与播报里的最大展示字符数。 */
export const AD_DETECT_REASON_MAX_CHARS: number = 80;

/**
 * 贴纸包黑名单命中时的判定理由；包名来自已校验的 `ad_pack_blacklists`（不超过 64 字符），
 * 全文不超过 AD_DETECT_REASON_MAX_CHARS。所属模块：workers/antiRaid/adDetect/blacklistFastPath.ts。
 * @param pack 命中的贴纸包 short name。
 * @returns 写进日志、播报与命中样本的判定理由。
 */
export function adStickerBlacklistReason(pack: string): string {
  return `命中贴纸黑名单 (${pack})`;
}

/**
 * 自定义表情包黑名单命中时的判定理由；包名来自已校验的 `ad_pack_blacklists`（不超过 64 字符），
 * 全文不超过 AD_DETECT_REASON_MAX_CHARS。所属模块：workers/antiRaid/adDetect/blacklistFastPath.ts。
 * @param pack 命中的自定义表情包 short name。
 * @returns 写进日志、播报与命中样本的判定理由。
 */
export function adEmojiBlacklistReason(pack: string): string {
  return `命中表情黑名单 (${pack})`;
}

/**
 * 随每条消息一起送检并写入命中样本的「被引用段」与「被回复原文」各自的最大字符数
 * （独立于 AD_DETECT_MESSAGE_MAX_CHARS，见 docs/cn/04-invariants.md 与 workers/antiRaid/adDetect/bundle.ts 的 claimSampleContextParts）。
 */
export const AD_SAMPLE_CONTEXT_MAX_CHARS: number = 200;

/** 广告检测没有可消费条目时复用的只读空列表。 */
export const EMPTY_AD_CANDIDATE_ENTRIES: readonly [] = [];

/** 自定义表情查询响应缺失对应 ID 时写入负缓存的只读单例。所属模块：workers/antiRaid/adDetect/blacklistFastPath.ts。 */
export const MISSING_CUSTOM_EMOJI_META: Readonly<CachedCustomEmojiMeta> = {
  setName: null,
  visionFileId: null,
  fileUniqueId: null,
};

/** 消息束不含可用视觉素材时共用的只读空多模态切片。所属模块：本文件的 EMPTY_RESOLVED_AD_BUNDLE_MEDIA。 */
const EMPTY_AD_BUNDLE_MEDIA_SLICE: Readonly<AdBundleMediaSlice> = {
  attachments: [],
  stickerPackCandidates: [],
  emojiPackCandidates: [],
};

/** 消息束不含可用视觉素材时复用的只读空解析结果单例。所属模块：workers/antiRaid/adDetect/media.ts。 */
export const EMPTY_RESOLVED_AD_BUNDLE_MEDIA: Readonly<ResolvedAdBundleMedia> = {
  combined: EMPTY_AD_BUNDLE_MEDIA_SLICE,
  direct: EMPTY_AD_BUNDLE_MEDIA_SLICE,
  hasUncheckedAttachments: false,
};

/** 广告命中后写入永久黑名单并在全部受管群封禁的无参动作常量（只读单例）。所属模块：states/adPunishment.ts。 */
export const AD_PUNISHMENT_BLOCK_GLOBAL: Readonly<AdPunishmentAction> = { kind: "blockGlobal" };

/** 频道身份无法禁言或移出时仅删除消息的无参动作常量（只读单例）。所属模块：states/adPunishment.ts。 */
export const AD_PUNISHMENT_DELETE_ONLY: Readonly<AdPunishmentAction> = { kind: "deleteOnly" };

/** 广告命中后仅在触发群封禁的无参动作常量（只读单例）。所属模块：states/adPunishment.ts。 */
export const AD_PUNISHMENT_BAN_CHAT: Readonly<AdPunishmentAction> = { kind: "banChat" };

/** 广告命中后仅移出触发群而不封禁的无参动作常量（只读单例）。所属模块：states/adPunishment.ts。 */
export const AD_PUNISHMENT_KICK: Readonly<AdPunishmentAction> = { kind: "kick" };
