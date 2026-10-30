import type { WhitelistPermissionKey, WhitelistPermissions } from "./identityPolicy";
import type { RandomImageMimeType } from "./randomImage";

/** Telegram WebApp `initData` 中解析出的用户身份摘要。 */
export interface MiniAppInitDataUser {
  readonly id: number;
  readonly firstName: string;
  readonly lastName?: string;
  /** 公开用户名（不含 `@`）。 */
  readonly username?: string;
}

/** `initData` 验签失败的原因分类。 */
export type MiniAppAuthFailureReason =
  | "missing_init_data" | "malformed_init_data" | "invalid_signature"
  | "expired_auth_date" | "missing_user" | "forbidden_user";

/** `initData` 验签与超级管理员身份核验结果。 */
export type MiniAppAuthResult =
  | { readonly ok: true; readonly authDate: number; readonly user: Readonly<MiniAppInitDataUser> }
  | { readonly ok: false; readonly reason: MiniAppAuthFailureReason };

/** 主线程内存中保存的 Mini App 密码认证会话记录（有效期 45 分钟）。 */
export interface MiniAppAuthSession {
  /** 64 位十六进制随机会话令牌。 */
  readonly token: string;
  /** 最近一次刷新前的旧会话令牌（距 `createdAt` 5 分钟宽限期内有效；新签发时为 `undefined`）。 */
  readonly previousToken: string | undefined;
  readonly createdAt: number;
  /** 会话过期毫秒时间戳（`createdAt + MINI_APP_SESSION_TTL_MS`）。 */
  readonly expiresAt: number;
}

/** 超级管理员 ID 的 Mini App 密码连续错误计数与 30 分钟锁定状态。 */
export interface MiniAppPasswordGuardState {
  readonly userId: number;
  /** 当前连续输错次数；达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 时锁定，锁定期内顺延的并发登录继续累加。 */
  readonly failedAttempts: number;
  /** 锁定截止毫秒时间戳（未锁定时为 `0`）。 */
  readonly lockedUntil: number;
}

/** 服务端返回的真实请求上下文与拒绝诊断信息（用于 403 访问拒绝页与鉴权诊断）。 */
export interface MiniAppAccessDiagnostics {
  /** 服务端为本次 HTTP 请求生成的 16 位十六进制请求追踪 ID（与 `X-Request-Id` 响应头一致）。 */
  readonly requestId: string;
  /** 服务端处理本次请求时的真实 UTC 时间字符串（`YYYY-MM-DD HH:mm:ss UTC`）。 */
  readonly timestamp: string;
  readonly clientIp: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly code: string;
  readonly error: string;
  /** 凭据校验失败时剩余的可尝试次数（仅 `INVALID_PASSWORD` / `INVALID_TOTP_CODE` 携带）。 */
  readonly remainingAttempts?: number;
  /** 处于 30 分钟锁定期时剩余的锁定分钟数（仅 `PASSWORD_LOCKED` 携带）。 */
  readonly remainingMinutes?: number;
}

/** `POST /api/auth/login` 密码或 TOTP 认证成功响应。 */
export interface MiniAppLoginSuccessResponse {
  readonly ok: true;
  /** 签发的 64 位十六进制会话令牌。 */
  readonly sessionToken: string;
  readonly expiresAt: number;
  /** 会话总有效时长毫秒数（45 分钟 = 2,700,000 ms）。 */
  readonly ttlMs: number;
  /** 供受保护图片与 SVG 资源跨会话稳定缓存复用的确定性鉴权令牌。 */
  readonly assetToken?: string;
}

/** Mini App HTTP 路由中间件链与处理器共享的请求上下文。 */
export interface MiniAppRouteContext {
  /** 原始 HTTP 请求对象。 */
  readonly request: Request;
  /** 已解析的请求 URL。 */
  readonly url: URL;
  /** 大写 HTTP 方法（如 `"GET"`、`"POST"`、`"DELETE"`、`"HEAD"`）。 */
  readonly method: string;
  /** 剥离基础路径前缀后的内部标准路由路径（如 `"/api/status"`）。 */
  readonly routePath: string;
  /** 动态路由路径参数映射（如 `{ chatId: "-100123", fileName: "abc.png" }`）。 */
  readonly params: Readonly<Record<string, string>>;
}

/** Mini App 标准路由处理器函数签名。 */
export type MiniAppRouteHandler = (
  ctx: Readonly<MiniAppRouteContext>
) => Response | Promise<Response>;

/** Mini App HTTP 中间件函数签名（可短路返回拦截响应，或调用 `next()` 进入下一环）。 */
export type MiniAppMiddleware = (
  ctx: Readonly<MiniAppRouteContext>,
  next: () => Response | Promise<Response>
) => Response | Promise<Response>;

/** 单项模型子能力或已加载任务的结构化明细项（供前端竖向样式化展示）。 */
export interface MiniAppCapabilityDetailItem {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

/** Mini App 首页展示的单个功能配置槽位状态。 */
export interface MiniAppCapabilityStatus {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly items: readonly Readonly<MiniAppCapabilityDetailItem>[];
}

/** `GET /api/mood` 返回的 AI 全局情绪实时状态视图。 */
export interface MiniAppMoodView {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
}

/** `POST /api/mood/switch` 触发重抽 AI 全局情绪后的响应结果。 */
export interface MiniAppMoodMutationResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
  readonly message: string;
}

/** Mini App 首页展示的活跃交互会话计数。 */
export interface MiniAppActiveSessionCounts {
  readonly total: number;
  readonly gag: number;
  readonly wed: number;
  readonly verify: number;
  readonly qaSet: number;
}

/** Mini App 首页展示的实时运行状态快照。 */
export interface MiniAppStatusView {
  readonly generatedAt: number;
  readonly uptimeMs: number;
  readonly cpuAveragePercent: number;
  readonly memoryPeakRssBytes: number;
  readonly memoryCurrentRssBytes: number;
  readonly memoryOtherBytes: number;
  readonly memoryTotalBytes: number;
  readonly memoryHeapUsedBytes: number;
  readonly memoryHeapTotalBytes: number;
  readonly managedChatCount: number;
  readonly whitelistCount: number;
  readonly blocklistCount: number;
  readonly activeSessions: Readonly<MiniAppActiveSessionCounts>;
  readonly telegramOutbound: Readonly<{
    readonly inFlight: number;
    readonly maxConcurrency: number;
    readonly waiting: number;
    readonly retryQueueSize: number;
    readonly retryQueueMax: number;
  }>;
  readonly capabilities: readonly Readonly<MiniAppCapabilityStatus>[];
}

/** 已 `/init` 群内可独立开关的子功能键。 */
export type MiniAppToggleableFeatureKey =
  | "aiChat" | "translation" | "adDetect" | "floodControl" | "antiRaid" | "proxySend";

/** Mini App 群详情页可操作的功能开关全集（含 `/init` 总开关）。 */
export type MiniAppFeatureKey = "init" | MiniAppToggleableFeatureKey;

/** 群聊的各项功能开关布尔状态。 */
export interface MiniAppChatFeatureFlags {
  readonly init: boolean;
  readonly aiChat: boolean;
  readonly translation: boolean;
  readonly adDetect: boolean;
  readonly floodControl: boolean;
  readonly antiRaid: boolean;
  /** `/send` 当前是否将该群设为私聊代发目标群。 */
  readonly proxySend: boolean;
}

/** 群列表项摘要信息（仅包含当前已开启 `/init` 的群聊）。 */
export interface MiniAppChatSummary {
  readonly chatId: number;
  readonly title: string;
  readonly features: Readonly<MiniAppChatFeatureFlags>;
  /** 当前热上下文消息条数（`0..256`）。 */
  readonly hotMessageCount: number;
  readonly qaPairCount: number;
  readonly isLockdownActive: boolean;
}

/** 群内 Bot 自身管理员权限视图。 */
export interface MiniAppChatBotPermissionsView {
  readonly canDeleteMessages: boolean;
  readonly canRestrictMembers: boolean;
  readonly canChangeInfo: boolean;
  readonly grantedLabels: readonly string[];
}

/** `/batch_kick` 触发来源：群内 `/batch_kick` 命令或 Mini App HTTP API。 */
export type BatchKickTriggerSource = "command" | "api";

/** Mini App 触发的 `/batch_kick` 批次执行完成后由回调写入服务端的汇总结果。 */
export interface MiniAppBatchKickCompletion {
  /** 本次清理回溯的小时数（`1..24`）。 */
  readonly hours: number;
  /** 窗口内读取到的去重入群记录总数。 */
  readonly recordCount: number;
  /** 真正进入处置的记录条数。 */
  readonly scanned: number;
  /** 成功踢出（解除封禁）的成员数。 */
  readonly kicked: number;
  /** 探测或踢出时确认已不在群内的成员数。 */
  readonly absent: number;
  /** 命中白名单保护而跳过的成员数。 */
  readonly protected: number;
  /** 命中永久黑名单的成员数。 */
  readonly blocked: number;
  /** 因缺少管理员权限或目标为群管理员而被 Telegram 拒绝的成员数。 */
  readonly forbidden: number;
  /** 因探测/踢出/补封请求失败或异常计入失败的成员数。 */
  readonly failed: number;
  /** 是否因身份策略读取失败提前中断。 */
  readonly aborted: boolean;
  /** 是否在执行途中因群不再受管而停止。 */
  readonly unmanaged: boolean;
  /** 批次执行完成的毫秒时间戳。 */
  readonly completedAt: number;
}

/** 群详细状态视图（在列表摘要基础上补充实时上下文、Bot 权限与活跃状态）。 */
export interface MiniAppChatDetail extends MiniAppChatSummary {
  /** 热上下文容量上限（固定为 `VERBATIM_CONTEXT_MAX = 256`）。 */
  readonly hotMessageMax: number;
  readonly quietRemainingMs: number;
  readonly lockdownRemainingMs: number;
  /** Bot 在该群的管理员权限快照；尚未探测时为 null。 */
  readonly botPermissions: Readonly<MiniAppChatBotPermissionsView> | null;
  readonly translateTargetCount: number;
  readonly deleteMessageTargetCount: number;
  /** 该群在最近 1..24 小时各回溯窗口内的去重入群人数（长度 24，下标 `hours - 1` 对应最近 `hours` 小时）。 */
  readonly joinedCountsByHour: readonly number[];
  /** 该群当前是否有 `/batch_kick` 批次正在后台执行。 */
  readonly batchKickRunning: boolean;
  /** 最近一次由 Mini App API 触发并执行完毕的 `/batch_kick` 汇总结果；未执行或正在执行中为 `null`。 */
  readonly lastBatchKickCompletion: Readonly<MiniAppBatchKickCompletion> | null;
  readonly activeSessions: Readonly<{
    readonly gag: number; readonly wed: boolean; readonly verify: number; readonly qaSet: boolean;
  }>;
}

/** 群按回溯小时数批量清理新进群成员（`/batch_kick`）的执行结果分类。 */
export type MiniAppBatchKickOutcome =
  | "accepted"
  | "empty"
  | "running"
  | "busy"
  | "unavailable"
  | "notInitialized"
  | "notSupergroup";

/** 群按回溯小时数批量清理新进群成员（`/batch_kick`）的响应结果。 */
export interface MiniAppBatchKickResult {
  readonly ok: boolean;
  readonly outcome: MiniAppBatchKickOutcome;
  /** 本次清理回溯的小时数（`1..24`）。 */
  readonly hours: number;
  /** 回溯窗口内命中的去重入群记录条数。 */
  readonly recordCount: number;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 群仍在已 `/init` 列表时返回最新群详情；已关闭 `/init` 时为 `null`。 */
  readonly detail: Readonly<MiniAppChatDetail> | null;
}

/** 群功能开关变更结果。 */
export interface MiniAppFeatureToggleResult {
  readonly ok: boolean;
  /** 变更是否使该群退出了已 `/init` 列表（关闭 `/init` 时为 true）。 */
  readonly removedFromList: boolean;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 本次变更对应的功能键（用于前端多语言提示插值）。 */
  readonly feature?: MiniAppFeatureKey;
  /** 未就绪的功能配置文件名（如 `"ai.json"`，用于前端多语言提示插值）。 */
  readonly configFile?: string;
  /** 群仍在已 `/init` 列表时返回最新群详情；已关闭 `/init` 时为 null。 */
  readonly detail: Readonly<MiniAppChatDetail> | null;
}

/** `/translate` 支持的目标翻译语言代码（`ja` 日语、`cn` 简体中文、`en` 美式英语、`uk` 乌克兰语、`ru` 俄语）。 */
export type MiniAppTranslateLanguage = "ja" | "cn" | "en" | "uk" | "ru";

/** 群内单条直答问答对视图（`/qa`）。 */
export interface MiniAppChatQaItem {
  /** 触发问题文本（主键）。 */
  readonly q: string;
  /** 回复答案文本（含可选 ``` 代码块围栏）。 */
  readonly a: string;
}

/** 群内单个追着删目标身份视图（`/delete_message`）。 */
export interface MiniAppChatDeleteTargetItem {
  /** 目标用户（正整数）或频道/群（负整数）ID。 */
  readonly id: number;
  /** 是否为频道或群会话身份（`id < 0`）。 */
  readonly isChannel: boolean;
  /** 人类可读展示名。 */
  readonly displayName: string;
  /** 可选公开用户名（不含 `@`）。 */
  readonly username?: string;
}

/** 群内单个追着翻目标身份视图（`/translate`）。 */
export interface MiniAppChatTranslateTargetItem {
  /** 目标用户（正整数）或频道/群（负整数）ID。 */
  readonly id: number;
  /** 是否为频道或群会话身份（`id < 0`）。 */
  readonly isChannel: boolean;
  /** 人类可读展示名。 */
  readonly displayName: string;
  /** 可选公开用户名（不含 `@`）。 */
  readonly username?: string;
  /** 目标翻译方向语言代码。 */
  readonly language: MiniAppTranslateLanguage;
}

/** `GET /api/chats/:chatId/targets` 返回的本群问答对、追着删目标与追着翻目标完整管理视图。 */
export interface MiniAppChatTargetsView {
  readonly chatId: number;
  /** 本群已登记的问答对列表。 */
  readonly qaItems: readonly Readonly<MiniAppChatQaItem>[];
  /** 单群问答对容量上限（`CHAT_QA_MAX_PER_CHAT = 15`）。 */
  readonly qaMax: number;
  /** 单条问题最大字符数（`CHAT_QA_QUESTION_MAX_CHARS = 256`）。 */
  readonly qaQuestionMaxChars: number;
  /** 单条答案最大字符数（`CHAT_QA_ANSWER_MAX_CHARS = 3840`）。 */
  readonly qaAnswerMaxChars: number;
  /** 本群已登记的追着删目标列表。 */
  readonly deleteMessageTargets: readonly Readonly<MiniAppChatDeleteTargetItem>[];
  /** 单群追着删目标容量上限（`DELETE_MESSAGE_CHAT_TARGET_MAX = 15`）。 */
  readonly deleteMessageMax: number;
  /** 本群已登记的追着翻目标列表。 */
  readonly translateTargets: readonly Readonly<MiniAppChatTranslateTargetItem>[];
  /** 单群追着翻目标容量上限（`TRANSLATE_CHAT_USER_LIMIT = 5`）。 */
  readonly translateMax: number;
  /** 本群当前是否已开启 `/translate` 总开关。 */
  readonly isTranslationEnabled: boolean;
}

/** `POST /api/chats/:chatId/targets` 支持的变更动作枚举。 */
export type MiniAppChatTargetsMutationAction =
  | "setQa"
  | "removeQa"
  | "addDeleteTarget"
  | "removeDeleteTarget"
  | "addTranslateTarget"
  | "removeTranslateTarget";

/** `POST /api/chats/:chatId/targets` 群内问答对、追着删目标与追着翻目标增删请求载荷。 */
export interface MiniAppChatTargetsMutationRequest {
  readonly action: MiniAppChatTargetsMutationAction;
  /** 问题文本（`setQa` / `removeQa` 必填）。 */
  readonly q?: string;
  /** 答案文本（`setQa` 必填）。 */
  readonly a?: string;
  /** 目标身份参数文本，支持用户/频道数字 ID 或 `@username`（`addDeleteTarget` / `addTranslateTarget` 必填）。 */
  readonly target?: string;
  /** 待移除的目标数字 ID（`removeDeleteTarget` / `removeTranslateTarget` 必填）。 */
  readonly id?: number;
  /** 翻译方向语言代码（`addTranslateTarget` 必填）。 */
  readonly language?: MiniAppTranslateLanguage;
}

/** `POST /api/chats/:chatId/targets` 变更执行结果。 */
export interface MiniAppChatTargetsMutationResult {
  readonly ok: boolean;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 最新目标管理列表快照；群未开启 `/init` 时为 `null`。 */
  readonly targets: Readonly<MiniAppChatTargetsView> | null;
  /** 最新群详情快照（用于同步更新顶栏计数与群卡片状态）；群未开启 `/init` 时为 `null`。 */
  readonly detail: Readonly<MiniAppChatDetail> | null;
}

/** 群热上下文（最多 256 条）中的单条发言记录视图（不含压缩记忆摘要）。 */
export interface MiniAppMessageItem {
  /** 在热缓冲区中的原始顺序索引（`0` 为缓冲区最早一条）。 */
  readonly index: number;
  readonly userId: number;
  readonly name: string;
  readonly username?: string;
  readonly text: string;
  /** 已格式化的配置时区发言时间（`YYYY/MM/DD HH:mm:ss`）。 */
  readonly at: string;
  readonly messageId: number;
  readonly forwardedFrom?: string;
  readonly replyToMessageId?: number;
  readonly replyToName?: string;
  readonly replyToPreview?: string;
}

/** 群热发言记录分页响应（仅来自 `buffer` 热 256 条，不含 `summaries` 与 `pendingSummary`）。 */
export interface MiniAppMessagePage {
  readonly chatId: number;
  readonly title: string;
  readonly total: number;
  readonly maxCapacity: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  /** 当前页的发言记录列表（按缓冲区最新发言在前排列）。 */
  readonly items: readonly Readonly<MiniAppMessageItem>[];
}

/** 白名单与权限列表单项视图。 */
export interface MiniAppWhitelistEntryView {
  readonly id: number;
  /** 是否为频道/群会话身份（`id < 0` 或 `meta.isChannel === true`）。 */
  readonly isChannel: boolean;
  readonly displayName: string;
  readonly username?: string;
  readonly permissions: Readonly<WhitelistPermissions>;
}

/** 黑名单列表单项视图。 */
export interface MiniAppBlocklistEntryView {
  readonly id: number;
  readonly isChannel: boolean;
  readonly displayName: string;
  readonly username?: string;
  /** 加入黑名单的配置时区时间字符串（`YYYY/MM/DD HH:mm:ss`）。 */
  readonly blockedAt: string;
}

/** 白名单权限键元数据（键名与中文说明）。 */
export interface MiniAppPermissionDescriptor {
  readonly key: WhitelistPermissionKey;
  readonly description: string;
}

/** 白名单分页响应。 */
export interface MiniAppWhitelistPage {
  readonly items: readonly Readonly<MiniAppWhitelistEntryView>[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly whitelistTotal: number;
  readonly blocklistTotal: number;
  /** 下一页游标（传入下一次请求的 `afterId`）；无更多页时为 null。 */
  readonly nextAfterId: number | null;
  readonly permissionDescriptors: readonly Readonly<MiniAppPermissionDescriptor>[];
}

/** 黑名单分页响应。 */
export interface MiniAppBlocklistPage {
  readonly items: readonly Readonly<MiniAppBlocklistEntryView>[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly whitelistTotal: number;
  readonly blocklistTotal: number;
  /** 下一页游标（传入下一次请求的 `afterId`）；无更多页时为 null。 */
  readonly nextAfterId: number | null;
}

/** 名单或权限变更操作结果。 */
export interface MiniAppIdentityMutationResult {
  readonly ok: boolean;
  readonly changed: boolean;
  /** 是否因目标已存在于名单中而触发重复添加提示。 */
  readonly duplicate?: boolean;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 本次操作的目标身份 ID（用于前端多语言提示插值）。 */
  readonly id?: number;
  /** 本次操作的单个白名单权限键（用于前端多语言提示插值）。 */
  readonly key?: WhitelistPermissionKey;
  /** 本次操作的单个白名单权限目标布尔值（用于前端多语言提示插值）。 */
  readonly value?: boolean;
  /** 内存态已更新时，SQLite 落盘是否一并成功。 */
  readonly persisted?: boolean;
  /** 黑名单操作在受管管理员群中实际成功执行跨群封禁/解封的群数量。 */
  readonly affectedChats?: number;
  /** 黑名单操作尝试跨群封禁/解封的受管管理员群总数量。 */
  readonly totalChats?: number;
}

/** Mini App 原生选择器目标名单类型（支持白名单、黑名单、群内删发言目标与群内翻译目标）。 */
export type MiniAppPickerTargetList =
  | "whitelist"
  | "blocklist"
  | "deleteMessage"
  | "translate";

/** Mini App 原生选择器挑选的身份种类（好友/联系人用户 vs 频道）。 */
export type MiniAppPickerSubjectKind = "users" | "channel";

/** 已向 Telegram Bot API 预注册的 `savePreparedKeyboardButton` 选择器会话记录。 */
export interface MiniAppPreparedPickerSession {
  /** 32 位正整数请求 ID（对应 `KeyboardButtonRequestUsers.request_id` / `KeyboardButtonRequestChat.request_id`）。 */
  readonly requestId: number;
  readonly preparedButtonId: string;
  readonly targetList: MiniAppPickerTargetList;
  readonly subjectKind: MiniAppPickerSubjectKind;
  /** 当 `targetList` 为 `"deleteMessage"` 或 `"translate"` 时所属的受管群 ID。 */
  readonly chatId?: number;
  /** 当 `targetList` 为 `"translate"` 时所选的目标翻译方向语言。 */
  readonly language?: MiniAppTranslateLanguage;
  readonly createdAt: number;
}

/** `POST /api/picker/prepare` 预备原生选择器的返回结果。 */
export type PrepareMiniAppPickerResult =
  | {
    readonly ok: true;
    readonly requestId: number;
    readonly preparedButtonId: string;
  }
  | {
    readonly ok: false;
    readonly message: string;
  };

/** `users_shared` 或 `chat_shared` 处理完成后的事件回执，供前端查询反馈。 */
export interface MiniAppPickerResultEvent {
  readonly requestId: number;
  readonly targetList: MiniAppPickerTargetList;
  readonly completedAt: number;
  readonly addedIds: readonly number[];
  readonly skippedIds: readonly number[];
  /** 因已在目标名单中而跳过重复添加的目标 ID 列表。 */
  readonly duplicateIds?: readonly number[];
  readonly summary: string;
}

/** 图库分页列表中的单张图片元数据视图。 */
export interface MiniAppGalleryItem {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

/** 图库分页响应视图。 */
export interface MiniAppGalleryPage {
  readonly directory: string;
  readonly exists: boolean;
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly items: readonly Readonly<MiniAppGalleryItem>[];
}

/** Mini App 图库单张图片上传入库的结局分类。 */
export type MiniAppGalleryUploadOutcome =
  | "added" | "existing" | "missingDirectory" | "empty"
  | "tooLarge" | "unsupportedFormat" | "invalidDimensions" | "failed";

/** Mini App 图库上传单张图片的响应结果。 */
export interface MiniAppGalleryUploadResult {
  readonly ok: boolean;
  readonly outcome: MiniAppGalleryUploadOutcome;
  readonly fileName?: string;
  /** 服务端返回的英文状态码字串，由前端映射为多语言提示。 */
  readonly message: string;
  /** 尺寸超限时检测到的图片像素宽度。 */
  readonly width?: number;
  /** 尺寸超限时检测到的图片像素高度。 */
  readonly height?: number;
}

/** Mini App 图库单张图片删除的结局分类。 */
export type MiniAppGalleryDeleteOutcome = "deleted" | "notFound" | "invalidFileName" | "failed";

/** Mini App 图库删除单张图片的响应结果。 */
export interface MiniAppGalleryDeleteResult {
  readonly ok: boolean;
  readonly outcome: MiniAppGalleryDeleteOutcome;
  readonly fileName?: string;
  readonly message: string;
}

/** 已解析并通过安全校验的图库单张图片文件句柄信息。 */
export interface ResolvedMiniAppGalleryFile {
  readonly fileName: string;
  readonly filePath: string;
  readonly mimeType: RandomImageMimeType;
  readonly sizeBytes: number;
  readonly etag: string;
}
