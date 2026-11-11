import type { ChatToggleFeature } from "../chatState";

/** 已 `/init` 群内可独立开关的子功能键：与开关命令共用落盘编排的群功能，加上 `/send` 代发目标。 */
export type MiniAppToggleableFeatureKey = ChatToggleFeature | "proxySend";

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
  /** 未就绪的功能配置文件名（如 `"agent.json"`，用于前端多语言提示插值）。 */
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
