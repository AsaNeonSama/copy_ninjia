/**
 * Mini App 前端类型。与 `packages/types/miniApp.ts` 同名的声明是 HTTP 接口契约副本，
 * 由 `test/mini-app-frontend/frontendParity.test.ts` 逐项核对与服务端一致；其余声明只属于前端。
 */

import type { WhitelistPermissionKey, WhitelistPermissions } from "./identityPolicy";
import type { MiniAppAuthMode } from "./miniAppTotp";

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

/** `GET /api/auth/precheck` 首屏签名预检结果。 */
export type MiniAppPrecheckResult =
  | {
    readonly ok: true;
    readonly ttlMs: number;
    /** 当前是否已配置并启用谷歌验证器（TOTP）。 */
    readonly totpEnabled?: boolean;
    /** 当前登录门禁优先使用的认证方式（有验证器时为 `"totp"`，否则为 `"password"`）。 */
    readonly authMode?: MiniAppAuthMode;
    /** 供受保护图片与 SVG 资源跨会话稳定缓存复用的确定性鉴权令牌。 */
    readonly assetToken?: string;
    /** 客户端持久化的会话令牌在服务端是否仍在 45 分钟有效期内。 */
    readonly sessionValid?: boolean;
    /** 客户端持久化会话在服务端的到期毫秒时间戳（无效或未携带时为 `0`）。 */
    readonly sessionExpiresAt?: number;
  }
  | {
    readonly ok: false;
    readonly diagnostics: Readonly<MiniAppAccessDiagnostics>;
  };

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
  readonly missingLabels: readonly string[];
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
  readonly activeSessions: Readonly<{
    readonly gag: number; readonly wed: boolean; readonly verify: number; readonly qaSet: boolean;
  }>;
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

/** Mini App 原生选择器目标名单类型。 */
export type MiniAppPickerTargetList = "whitelist" | "blocklist";

/** Mini App 原生选择器挑选的身份种类（好友/联系人用户 vs 频道）。 */
export type MiniAppPickerSubjectKind = "users" | "channel";

/** Mini App 名单添加折叠菜单的添加方式（按 ID、按联系人、按频道）。 */
export type MiniAppIdentityAddMode = "id" | "users" | "channel";

/** Mini App 界面支持的语言键（中文、日文、英文）。 */
export type MiniAppLanguage = "zh" | "ja" | "en";

/** Mini App 界面支持的主题模式（暗色、亮色）。 */
export type MiniAppThemeMode = "dark" | "light";

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

/** Mini App 主导航标签键。 */
export type MiniAppTabKey = "status" | "chats" | "identities" | "gallery" | "totp";

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

/** 名单管理子标签键。 */
export type MiniAppIdentitySubTabKey = "whitelist" | "blocklist";

/** Telegram WebApp `initDataUnsafe` 中当前用户信息。 */
export interface TelegramWebAppUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

/** Telegram WebApp 注入浏览器的宿主对象接口。 */
export interface TelegramWebApp {
  readonly initData?: string;
  readonly colorScheme?: "light" | "dark";
  readonly themeParams?: Readonly<Record<string, string | undefined>>;
  readonly initDataUnsafe?: Readonly<{ readonly user?: Readonly<TelegramWebAppUser> }>;
  readonly ready?: () => void;
  readonly expand?: () => void;
  readonly setHeaderColor?: (color: string) => void;
  readonly setBackgroundColor?: (color: string) => void;
  readonly isVersionAtLeast?: (version: string) => boolean;
  /** 唤起 Telegram 客户端原生文件下载器将 HTTPS 资源保存至系统默认下载目录（Bot API 8.0+）。 */
  readonly downloadFile?: (
    params: Readonly<{ readonly url: string; readonly file_name: string }>,
    callback?: (accepted: boolean) => void
  ) => void;
  /** 唤起 `savePreparedKeyboardButton` 创建的原生好友/联系人/群组/频道选择器（Bot API 9.6+）。 */
  readonly requestChat?: (preparedButtonId: string, callback?: (accepted: boolean) => void) => void;
}

/** 供浏览器触发附件保存的临时 `<a download>` 节点最小接口。 */
export interface MiniAppDownloadAnchorElement {
  href: string;
  download: string;
  rel: string;
  readonly style: { display: string };
  readonly click: () => void;
  readonly remove: () => void;
}

/** 浏览器 Web Storage（`localStorage` / `sessionStorage`）最小读写接口。 */
export interface MiniAppWebStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

/** 带有可选 `Telegram.WebApp` 与标准浏览器宿主能力的全局窗口视图。 */
export interface TelegramWindow {
  readonly Telegram?: Readonly<{ readonly WebApp?: Readonly<TelegramWebApp> }>;
  /** 当前浏览器会话已解锁的 Mini App 45 分钟认证令牌。 */
  __copyNinjaSessionToken?: string;
  /** 当前浏览器会话已解锁的认证令牌到期毫秒时间戳。 */
  __copyNinjaSessionExpiresAt?: number;
  /** 供受保护图片与 SVG 资源跨会话稳定缓存复用的确定性鉴权令牌。 */
  __copyNinjaAssetToken?: string;
  readonly localStorage?: Readonly<MiniAppWebStorage>;
  readonly sessionStorage?: Readonly<MiniAppWebStorage>;
  readonly location?: Readonly<{ readonly href?: string; readonly host?: string; readonly search: string; readonly hash: string }>;
  readonly confirm?: (message?: string) => boolean;
  readonly scrollTo?: (
    options: Readonly<{ readonly top: number; readonly behavior?: "auto" | "instant" | "smooth" }>
  ) => void;
  readonly navigator?: Readonly<{ readonly language?: string; readonly languages?: readonly string[] }>;
  readonly document?: Readonly<{
    readonly getElementById: (elementId: string) => Element | null;
    readonly createElement?: (tagName: "a") => MiniAppDownloadAnchorElement;
    readonly body?: Readonly<{ readonly appendChild?: (node: MiniAppDownloadAnchorElement) => void }>;
    readonly documentElement?: Readonly<{ readonly setAttribute?: (qualifiedName: string, value: string) => void }>;
  }>;
}

/** 功能开关在前端展示的标题、对应命令与说明。 */
export interface MiniAppFeatureDisplayMeta {
  readonly label: string;
  readonly command: string;
  readonly description: string;
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
