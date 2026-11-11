import type { WhitelistPermissionKey, WhitelistPermissions } from "../identityPolicy";
import type { MiniAppTranslateLanguage } from "./chats";

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
