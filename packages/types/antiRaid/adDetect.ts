/** 广告检测流水线的跨线程协议与 Worker 内部纯数据形状。 */
import type { Chat, Message } from "grammy/types";
import type { TelegramIdentityMetadata } from "../identityPolicy";
import type { VisionImage } from "../media";

/** 参与多模态广告检测的图片附件来源类型。 */
export type AdDetectMediaKind = "photo" | "sticker" | "custom_emoji";

/** 广告检测请求携带的单张视觉附件及其归属包元信息。 */
export interface AdDetectMediaAttachment {
  /** 本次消息束内稳定的附件标识（用于提示词与媒体顺序对齐）。 */
  readonly id: string;
  /** 附件来源类型：普通图片/图片文件、贴纸或自定义表情。 */
  readonly kind: AdDetectMediaKind;
  /** 贴纸或自定义表情所属包的 short name；普通图片或无所属包时为 undefined。 */
  readonly packName: string | undefined;
  /** 已转为 JPEG/PNG 的视觉输入字节。 */
  readonly image: VisionImage;
}

/** 单次模型送检（整串或本人直发）携带的多模态视觉附件与合法包归因候选。 */
export interface AdBundleMediaSlice {
  /** 已下载并转为 JPEG/PNG 的视觉附件列表。 */
  readonly attachments: readonly AdDetectMediaAttachment[];
  /** 本切片附件中具备合法包名的贴纸包 short name 去重列表。 */
  readonly stickerPackCandidates: readonly string[];
  /** 本切片附件中具备合法包名的自定义表情包 short name 去重列表。 */
  readonly emojiPackCandidates: readonly string[];
}

/** 消息束多模态素材解析结果，同时包含整串、发送者本人直发两份切片及未检附件标记。 */
export interface ResolvedAdBundleMedia {
  /** 整串入选条目（含转发与引用）对应的多模态切片。 */
  readonly combined: AdBundleMediaSlice;
  /** 仅发送者本人直发条目（`!entry.isForwarded`）对应的多模态切片。 */
  readonly direct: AdBundleMediaSlice;
  /** 至少有一张成功加载并纳入累积字节预算的附件来自未检条目（`entry.seq > checkedSeq`）时为 `true`。 */
  readonly hasUncheckedAttachments: boolean;
}

/** 当前 `agent.ad_detect` 模型多模态图片输入能力探测状态。 */
export type AdDetectVisionSupportState = "unknown" | "supported" | "unsupported";

/** 自定义表情 ID 的缓存元数据：所属包名与可下载视觉素材标识。 */
export interface CachedCustomEmojiMeta {
  /** 自定义表情所属表情包 short name；未归属任何表情包时为 null。 */
  readonly setName: string | null;
  /** 可用于视觉下载的静态本体或缩略图 file_id；无可用静态图或缩略图时为 null。 */
  readonly visionFileId: string | null;
  /** 贴纸自身的稳定去重键 `file_unique_id`；不可用时为 null。 */
  readonly fileUniqueId: string | null;
}

/** 广告检测各供应商传输层的统一返回态。 */
export type AdDetectProviderResult =
  | { readonly status: "ok"; readonly body: string }
  | { readonly status: "visionUnsupported" }
  | { readonly status: "failed" };

/** 广告消息束分类入口（支持文本与多模态附件及包归因候选）的入参。 */
export interface ClassifyAdBundleOptions {
  /** 按行编号的待判定消息串（见 adDetect/bundle.ts）。 */
  readonly text: string;
  /** 发送者是否仍处于入群验证窗口内。 */
  readonly justJoined: boolean;
  /** 本次送检附带的视觉图片列表（照片、贴纸或自定义表情）。 */
  readonly attachments?: readonly AdDetectMediaAttachment[];
  /** 本次消息束中出现、需要模型显式归因的贴纸包 short name 候选列表。 */
  readonly stickerPackCandidates?: readonly string[];
  /** 本次消息束中出现、需要模型显式归因的自定义表情包 short name 候选列表。 */
  readonly emojiPackCandidates?: readonly string[];
}

/**
 * 同一条群消息的广告累计与候选构建共用事实；构造后保持固定 shape。只为通过
 * antiRaid/adCandidate.ts 的 adDetectionSenderId 前置判定的消息构造。
 */
export interface AdDetectionMessageContext {
  /** 当前处理的 Telegram 群聊消息。 */
  readonly message: Message;
  /** 当前运行机器人的 Telegram 用户 ID。 */
  readonly botId: number;
  /** 本次 update 统一读取的观测时间戳（毫秒）。 */
  readonly now: number;
  /** adDetectionSenderId 判出的展示身份 id（频道马甲优先，否则 from.id）。 */
  readonly senderId: number;
  /** 消息的可见频道身份（见 users/visibleSender.ts）；普通用户发言为 undefined。 */
  readonly senderChat: Chat | undefined;
}

/**
 * 广告检测向任一 provider 发送的中立结构化请求。模型与采样预算属于判定领域，
 * 传输实现只把这些语义映射到各自 SDK。
 */
export interface AdDetectJsonRequestParams {
  /** 模型名来自 config/dynamic/agent.json 的 agent.ad_detect。 */
  readonly model: string;
  /** 判定规则与部署示例段，不含系统事实；Gemini 路径的系统指令，Anthropic 路径带缓存断点的首个系统块。 */
  readonly instructions: string;
  /** 本次的系统事实一行；Gemini 路径把它作为 user 轮里排在 userContent 之前的独立 part，Anthropic 路径作为缓存断点之后的第二个系统块。 */
  readonly fact: string;
  /**
   * instructions、换行与 fact 拼成的完整系统提示词；OpenAI 兼容路径的 system 段。
   * OpenAI JSON 模式要求其中出现 json。
   */
  readonly systemPrompt: string;
  /** 本次待处理的用户内容；一律当数据，不承担指令语义。 */
  readonly userContent: string;
  /** 模型采样温度（仅 OpenAI 兼容传输写入请求体；Anthropic 与 Google 路径省略该字段并沿用各自默认采样行为）。 */
  readonly temperature: number;
  /** 单次响应允许生成的最大输出 token 数。 */
  readonly maxOutputTokens: number;
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
  /** 可选的多模态视觉附件列表；缺省或为空时按纯文本请求发送。 */
  readonly attachments?: readonly AdDetectMediaAttachment[];
  /** 本次送检待归因的贴纸包 short name 候选列表。 */
  readonly stickerPackCandidates?: readonly string[];
  /** 本次送检待归因的自定义表情包 short name 候选列表。 */
  readonly emojiPackCandidates?: readonly string[];
}

/**
 * 按当前广告检测配置（`config/dynamic/ad_detect.json`）中的示例拼好的判定提示词（见 `cache/workers/antiRaid/adDetect.ts`）。
 * 各系统提示词共用同一份 instructions 前缀；系统提示词 = instructions + 换行 + 对应的系统事实。
 */
export interface AdDetectPrompts {
  /** 判定规则与部署示例段，不含系统事实。 */
  readonly instructions: string;
  /** 发送者仍在入群验证窗口内时的完整系统提示词。 */
  readonly justJoinedSystemPrompt: string;
  /** 发送者不在入群验证窗口内时的完整系统提示词。 */
  readonly establishedSystemPrompt: string;
}

/** 参与判定、同时写进命中样本的上下文。两项都可能缺席。 */
export interface AdSampleContext {
  /** 这条消息里被引用的那一段（message.quote）；没有时为 undefined，键恒写。 */
  quote: string | undefined;
  /** 这条消息回复的那条原消息的正文；没有时为 undefined，键恒写。 */
  replyTo: string | undefined;
}

/**
 * 主线程 -> Worker：一条待广告判定的群消息。只有本群开了 /ad_detect enable、
 * 机器人是本群管理员、且发送者不是自己人时才投递（见 antiRaid/adCandidate.ts）。
 * Worker 侧按发送者归并成消息串排队送检，见 workers/antiRaid/adDetect/queue.ts。
 *
 * 字段全部必填、缺省显式 undefined，除 linkUrls、customEmojiIds 外只含原始值；发送者元数据与引用
 * 上下文平铺成独立字段，Worker 侧按需重新组装。
 */
export interface AdCandidateMessage {
  type: "adCandidate";
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  messageId: number;
  /**
   * 主线程观测到这条 update 的时刻，本条消息在 Worker 侧的全部时间判定都用它。
   *
   * 由主线程按 update 唯一的那次时钟读取填入（见 infra/updateContext.ts 的
   * updateNow），Worker 不为每条候选再读墙钟。它是主线程收到这条消息的时刻，
   * 不是 Worker 从 mailbox 取到它的时刻。
   */
  observedAt: number;
  /** 已清洗成单行的正文（文本或图片说明）。 */
  text: string;
  /**
   * Telegram 展示元数据（口径同 TelegramIdentityMetadata）；用户的 firstName、lastName
   * 同时参与当次广告检测。
   */
  firstName: string;
  lastName: string;
  username: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /** 当前消息是手工转发；其 text/caption 归属于 forward_origin，而非转发者本人。 */
  isForwarded: boolean;
  /** 发送者此刻是否已经在永久黑名单里。 */
  blocked: boolean;
  /** 发送者此刻是否仍在入群验证窗口内。 */
  justJoined: boolean;
  /** 正文里不可见的 text_link 落地页 URL；没有时为 undefined。 */
  linkUrls: string[] | undefined;
  /** 消息携带的贴纸所属贴纸包 short name（message.sticker?.set_name）；无贴纸或未归属贴纸包时为 undefined。 */
  stickerSetName: string | undefined;
  /** 贴纸用于视觉下载的静态本体或缩略图 file_id；无可用素材时为 undefined。 */
  readonly stickerFileId: string | undefined;
  /** 贴纸自身的稳定去重键 `file_unique_id`；无可用素材时为 undefined。 */
  readonly stickerFileUniqueId: string | undefined;
  /** 普通图片或图片文件用于视觉下载的 file_id；无图片素材时为 undefined。 */
  readonly imageFileId: string | undefined;
  /** 普通图片或图片文件的稳定去重键 `file_unique_id`；无图片素材时为 undefined。 */
  readonly imageFileUniqueId: string | undefined;
  /** 消息或图注实体中的自定义表情 ID 去重列表（custom_emoji 实体）；没有时为 undefined。 */
  customEmojiIds: string[] | undefined;
  /**
   * 被引用段与被回复原文（口径同 AdSampleContext 的 quote 与 replyTo）；与 text 一起
   * 参与判定并留进命中样本，缺席时为 undefined。
   */
  sampleQuote: string | undefined;
  sampleReplyTo: string | undefined;
}

/** 主线程 -> Worker：丢掉这个群尚未送检的广告判定队列。 */
export interface ClearAdDetectMessage {
  type: "clearAdDetect";
  chatId: number;
}

/**
 * 主线程 -> Worker：某身份进入永久白名单或刚获得临时广告免检时，清除该身份在各群
 * 尚未结算的广告检测队列、消息束、引用警告状态与处置抑制记录。
 */
export interface ClearIdentityAdDetectMessage {
  type: "clearIdentityAdDetect";
  identityId: number;
}

/**
 * 主线程 -> Worker：主线程拒绝广告处置或非全局封禁处置结算后，释放指定群与发送者的处置抑制记录。
 */
export interface ReleaseAdDetectDedupMessage {
  type: "releaseAdDetectDedup";
  chatId: number;
  senderId: number;
}

/** 命中样本中单条消息的类型。 */
export type AdSampleMessageType = "text" | AdDetectMediaKind;

/** 命中样本里的一条消息：消息类型、实际送检文本（无送检文本时省略）、贴纸包名及单独保留的引用上下文。 */
export interface AdSampleMessage extends AdSampleContext {
  messageId: number;
  /** 消息类型（`"text"`、`"photo"`、`"sticker"` 或 `"custom_emoji"`）。 */
  type: AdSampleMessageType;
  /**
   * 送检时的文本内容（当次用户姓名、已截断正文/图注与 text_link 落地页），与模型读到的完全一致；
   * 无送检文本时为 undefined（落盘序列化时省略）。
   */
  text?: string;
  /** 贴纸消息所属贴纸包 short name；非贴纸或无所属包时为 undefined（落盘序列化时省略）。 */
  stickerSetName?: string;
}

/** Worker -> 主线程：发送者被判成广告，请主线程复核开关与受保护身份后执行删消息并按 ad_detect.json 的处罚设置处置。 */
export interface AdDetectedEvent {
  type: "adDetected";
  chatId: number;
  senderId: number;
  isChannel: boolean;
  /** 处置播报里的展示标签，Worker 按 meta 与本进程氛围算好。 */
  label: string;
  meta: Readonly<TelegramIdentityMetadata>;
  /** 命中原因摘要（贴纸包或自定义表情包黑名单命中说明，或模型给出的简短理由），只进日志、播报与命中样本；不参与控制流。 */
  reason: string;
  /** 本次判定依据的完整消息串。 */
  messages: readonly AdSampleMessage[];
  /** Worker 汇总的待删除涉事消息 ID（送检条目 ∪ 当前束内条目 ∪ 淘汰待删 ID）；仅主线程裁决通过后执行删除。 */
  readonly deleteMessageIds: readonly number[];
  /** 模型明确归因为广告的贴纸包 short name 列表（供主线程自动写入 SQLite `ad_pack_blacklists`）。 */
  readonly adStickerPacks?: readonly string[];
  /** 模型明确归因为广告的自定义表情包 short name 列表（供主线程自动写入 SQLite `ad_pack_blacklists`）。 */
  readonly adEmojiPacks?: readonly string[];
}

/** 一条参与广告判定的消息。 */
export interface AdCandidateEntry extends AdSampleContext {
  messageId: number;
  /** 本串内单调递增的序号，判定进度按它记账（见 AdMessageBundle.checkedSeq）。 */
  seq: number;
  /** 当次用户姓名与已限长的正文、落地页、引用上下文；参与整串送检预算。 */
  text: string;
  /** 本条发送者姓名与经过限长/链接拼接的正文（不含 quote/replyTo），供警告结算重算引文去重。 */
  readonly senderText: string;
  /** 当前发送者本人的姓名与正文；转发消息只保留转发者姓名，用于直接广告归因。 */
  directText: string;
  /** 当前消息是否为手工转发；键恒写。 */
  readonly isForwarded: boolean;
  /**
   * 主线程观测时刻（入队时的 now，缺省即 AdCandidateMessage.observedAt）；用于回收
   * 去重窗口外已经消费过的上下文与冻结引用广告警告窗口；处置抑制另用 Worker 单调时钟。
   */
  receivedAt: number;
  /**
   * 本条到达时是否处于已经公开的引用广告警告窗口；该事实在入队时冻结，不用之后的
   * 处理墙钟重新推断。
   */
  withinReferencedWarning: boolean;
  /** 本条消息携带的贴纸所属贴纸包 short name；用于贴纸黑名单快路径检测，没有时为 undefined，键恒写。 */
  stickerSetName: string | undefined;
  /** 贴纸用于视觉下载的静态本体或缩略图 file_id；没有时为 undefined，键恒写。 */
  readonly stickerFileId: string | undefined;
  /** 贴纸自身的稳定去重键 `file_unique_id`；没有时为 undefined，键恒写。 */
  readonly stickerFileUniqueId: string | undefined;
  /** 普通图片或图片文件用于视觉下载的 file_id；没有时为 undefined，键恒写。 */
  readonly imageFileId: string | undefined;
  /** 普通图片或图片文件的稳定去重键 `file_unique_id`；没有时为 undefined，键恒写。 */
  readonly imageFileUniqueId: string | undefined;
  /** 本条消息携带的自定义表情 ID 去重列表；用于自定义表情包黑名单快路径与多模态视觉检测（workers/antiRaid/adDetect/media.ts），没有时为 undefined，键恒写。 */
  customEmojiIds: readonly string[] | undefined;
}

/** 某个发言者在一个群里累积的待检消息串（队列里只排它的键）。 */
export interface AdMessageBundle {
  /**
   * 本串的 `chatId:senderId` 键（verificationKey），建串时算一次；队列、在途、处置抑制与
   * 引用警告几张表都以它为键，同一发送者的后续消息直接取用、不重新拼键。
   */
  readonly key: string;
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  /**
   * 随候选冻结并在昵称变化时更新：命中后随 `AdDetectedEvent.meta` 回传主线程（当 `ad_detect.json`
   * 处罚配置为跨群拉黑 `kick.block=true, block_scope="global"` 时写入永久黑名单），同时供处置播报现算展示标签
   * （见 workers/antiRaid/adDetect/disposal.ts 的 adSenderLabel）。
   */
  meta: Readonly<TelegramIdentityMetadata>;
  /**
   * 送检姓名（workers/antiRaid/adDetect/senderName.ts 的 formatAdSenderName），建串时算出，
   * meta 的姓或名变化时随之重算；频道马甲恒为空串。
   */
  senderName: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /**
   * 这一串里是否有任何一条是「刚进群、还没通过验证」时发出的；取并集，不取最后一条。
   */
  justJoined: boolean;
  entries: AdCandidateEntry[];
  /**
   * 被单 key 条数上限挤出 entries、却从来没送过判定的消息 id；命中后并入处置的删除集合
   * （见 workers/antiRaid/adDetect/disposal.ts）。容量见 AD_DETECT_MAX_PENDING_DELETE_IDS。
   */
  pendingDeleteIds: number[];
  /**
   * 这一串已经因为待删列表撑满而丢过 id；该行错误日志每个发送者最多记一次。建串时为 false。
   */
  pendingDeleteOverflowed: boolean;
  /**
   * 这一串已经因为单 key 条数上限挤掉过从没判定过的正文；该行错误日志每个发送者最多
   * 记一次。建串时为 false。
   */
  uncheckedEvicted: boolean;
  /** 下一条消息要用的序号；只增不减，上下文裁剪不回退它。 */
  nextSeq: number;
  /**
   * 已送检过的最大序号；只有序号比它大的消息才重新入队。按序号记账，不按 entries 的
   * 数组下标。
   */
  checkedSeq: number;
}

/** 一次广告判定的结果；请求失败时调用方拿到 null，不做任何处置。 */
export interface AdVerdict {
  isAd: boolean;
  reason: string;
  /** 模型明确归因为广告的贴纸包 short name 列表（已按本轮候选集过滤）。 */
  readonly adStickerPacks?: readonly string[];
  /** 模型明确归因为广告的自定义表情包 short name 列表（已按本轮候选集过滤）。 */
  readonly adEmojiPacks?: readonly string[];
}

/** Worker -> 主线程：广告分类命中（贴纸/自定义表情包黑名单命中或模型判定为广告，含直接广告与仅引用命中）；用于清空连续合格日累计。 */
export interface AdVerdictTrueEvent {
  type: "adVerdictTrue";
  chatId: number;
  senderId: number;
}

/** 广告判定流水线向主线程发布的完整事件。 */
export type AdDetectionEvent = AdVerdictTrueEvent | AdDetectedEvent;

/** 一次广告消息串送检的取舍结果。 */
export interface AdBundleSelection {
  /** 本次真正交给模型的条目，按时间先后排列（已判上下文在前，未判内容在后）。 */
  entries: AdCandidateEntry[];
  /** 本次判到的最新未判条目序号；整串都已判过时等于 bundle.checkedSeq。 */
  checkedToSeq: number;
}
