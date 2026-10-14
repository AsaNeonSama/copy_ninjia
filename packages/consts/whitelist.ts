import type {
  WhitelistPermissionKey,
  WhitelistPermissions,
} from "../types/identityPolicy";
import { exhaustiveList } from "./exhaustiveList";

/** 白名单条目缺省不可使用手动禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_MUTE: boolean = false;
/** 白名单条目缺省不可使用手动解除禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_UNMUTE: boolean = false;
/** 白名单条目缺省不可使用 /gag 与 /ungag。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_GAG: boolean = false;
/** 白名单条目缺省可以查看 /bot_status。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_VIEW_BOT_STATUS: boolean = true;
/** 白名单条目缺省不可写入永久黑名单。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BLOCK: boolean = false;
/** 白名单条目缺省不可移出永久黑名单。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_UNBLOCK: boolean = false;
/** 白名单条目缺省不可代为新增其它白名单身份。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_WHITE_OTHER: boolean = false;
/** 白名单条目缺省不可重抽 AI 心情。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_SWITCH_MOOD: boolean = false;
/** 白名单条目缺省绕过广告检测。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_AD_DETECTION: boolean = true;
/** 白名单条目缺省绕过防刷屏禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL: boolean = true;
/** 白名单条目缺省不可开关 AI 闲聊。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关广告检测。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关防刷屏禁言。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关翻译功能。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_TRANSLATE_PERMISSION: boolean = false;
/** 白名单条目缺省不可开关入群守卫。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_ANTI_RAID_PERMISSION: boolean = false;
/** 白名单条目缺省不可维护本群问答。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_CONTROLL_QA_PERMISSION: boolean = false;
/** 白名单条目缺省不可往随机图库收图（`/h_image add`）。所属模块：packages/infra/identityPolicy/whitelist.ts。 */
const DEFAULT_IS_CAN_ADD_H_IMAGE: boolean = false;

/**
 * 新增白名单成员使用的完整默认权限视图（已持久化权限须逐项完整，不在读取时补齐）。
 * 所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const DEFAULT_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: DEFAULT_IS_CAN_MUTE,
  isCanUnMute: DEFAULT_IS_CAN_UNMUTE,
  isCanGag: DEFAULT_IS_CAN_GAG,
  isCanViewBotStatus: DEFAULT_IS_CAN_VIEW_BOT_STATUS,
  isCanBlock: DEFAULT_IS_CAN_BLOCK,
  isCanUnBlock: DEFAULT_IS_CAN_UNBLOCK,
  isCanWhiteOther: DEFAULT_IS_CAN_WHITE_OTHER,
  isCanSwitchMood: DEFAULT_IS_CAN_SWITCH_MOOD,
  isCanBypassAdDetection: DEFAULT_IS_CAN_BYPASS_AD_DETECTION,
  isCanBypassFloodControl: DEFAULT_IS_CAN_BYPASS_FLOOD_CONTROL,
  isCanControllAIPermission: DEFAULT_IS_CAN_CONTROLL_AI_PERMISSION,
  isCanClearContext: false,
  isCanControllAdDetectPermission: DEFAULT_IS_CAN_CONTROLL_AD_DETECT_PERMISSION,
  isCanControllFloodControlPermission: DEFAULT_IS_CAN_CONTROLL_FLOOD_CONTROL_PERMISSION,
  isCanControllTranslatePermission: DEFAULT_IS_CAN_CONTROLL_TRANSLATE_PERMISSION,
  isCanControllAntiRaidPermission: DEFAULT_IS_CAN_CONTROLL_ANTI_RAID_PERMISSION,
  isCanControllQaPermission: DEFAULT_IS_CAN_CONTROLL_QA_PERMISSION,
  isCanAddHImage: DEFAULT_IS_CAN_ADD_H_IMAGE,
};

/**
 * 非白名单身份的只读权限视图（逐项关闭，字段顺序与 DEFAULT_WHITELIST_PERMISSIONS 一致）。
 * 所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const NON_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: false,
  isCanUnMute: false,
  isCanGag: false,
  isCanViewBotStatus: false,
  isCanBlock: false,
  isCanUnBlock: false,
  isCanWhiteOther: false,
  isCanSwitchMood: false,
  isCanBypassAdDetection: false,
  isCanBypassFloodControl: false,
  isCanControllAIPermission: false,
  isCanClearContext: false,
  isCanControllAdDetectPermission: false,
  isCanControllFloodControlPermission: false,
  isCanControllTranslatePermission: false,
  isCanControllAntiRaidPermission: false,
  isCanControllQaPermission: false,
  isCanAddHImage: false,
};

/**
 * 临时广告免检与自动晋升白名单条目的固定权限视图（仅开启广告免检，字段顺序与 DEFAULT_WHITELIST_PERMISSIONS 一致）。
 * 所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const TEMPORARY_AD_BYPASS_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: false,
  isCanUnMute: false,
  isCanGag: false,
  isCanViewBotStatus: false,
  isCanBlock: false,
  isCanUnBlock: false,
  isCanWhiteOther: false,
  isCanSwitchMood: false,
  isCanBypassAdDetection: true,
  isCanBypassFloodControl: false,
  isCanControllAIPermission: false,
  isCanClearContext: false,
  isCanControllAdDetectPermission: false,
  isCanControllFloodControlPermission: false,
  isCanControllTranslatePermission: false,
  isCanControllAntiRaidPermission: false,
  isCanControllQaPermission: false,
  isCanAddHImage: false,
};

/**
 * 超级管理员的固定有效权限视图（逐项全开，不落盘，字段顺序与 DEFAULT_WHITELIST_PERMISSIONS 一致，见 docs/cn/04-invariants.md）。
 * 所属模块：packages/infra/identityPolicy/whitelist.ts。
 */
export const SUPER_ADMIN_WHITELIST_PERMISSIONS: Readonly<WhitelistPermissions> = {
  isCanMute: true,
  isCanUnMute: true,
  isCanGag: true,
  isCanViewBotStatus: true,
  isCanBlock: true,
  isCanUnBlock: true,
  isCanWhiteOther: true,
  isCanSwitchMood: true,
  isCanBypassAdDetection: true,
  isCanBypassFloodControl: true,
  isCanControllAIPermission: true,
  isCanClearContext: true,
  isCanControllAdDetectPermission: true,
  isCanControllFloodControlPermission: true,
  isCanControllTranslatePermission: true,
  isCanControllAntiRaidPermission: true,
  isCanControllQaPermission: true,
  isCanAddHImage: true,
};

/** 白名单权限策略与 /permission 共同接受的权限键全集。 */
export const WHITELIST_PERMISSION_KEYS: readonly WhitelistPermissionKey[] = exhaustiveList<WhitelistPermissionKey>()([
  "isCanMute",
  "isCanUnMute",
  "isCanGag",
  "isCanViewBotStatus",
  "isCanBlock",
  "isCanUnBlock",
  "isCanWhiteOther",
  "isCanSwitchMood",
  "isCanBypassAdDetection",
  "isCanBypassFloodControl",
  "isCanControllAIPermission",
  "isCanClearContext",
  "isCanControllAdDetectPermission",
  "isCanControllFloodControlPermission",
  "isCanControllTranslatePermission",
  "isCanControllAntiRaidPermission",
  "isCanControllQaPermission",
  "isCanAddHImage",
]);

/**
 * 权限键的小写输入到规范拼写的只读索引，命令解析按小写输入直接查找。
 * 所属模块：packages/commands/permission.ts。
 */
export const WHITELIST_PERMISSION_KEY_BY_LOWERCASE: ReadonlyMap<
  string,
  WhitelistPermissionKey
> = new Map(
  WHITELIST_PERMISSION_KEYS.map(
    (key: WhitelistPermissionKey): readonly [string, WhitelistPermissionKey] =>
      [key.toLowerCase(), key]
  )
);
if (WHITELIST_PERMISSION_KEY_BY_LOWERCASE.size !== WHITELIST_PERMISSION_KEYS.length) {
  throw new Error("WHITELIST_PERMISSION_KEYS must be unique after lower-case normalization");
}

/** /permission 的权限说明子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_HELP_COMMAND: string = "help";
/** /permission 查询自身或指定用户权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_QUERY_COMMAND: string = "query";
/** /permission 全开已有身份权限的子命令。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_ALL_COMMAND: string = "all";
/** /permission query 看板里 JSON 代码块的缩进空格数。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_JSON_INDENT: number = 2;
/** /permission help 与 query 看板里 JSON 代码块的语言标注。所属模块：packages/commands/permission.ts。 */
export const WHITELIST_PERMISSION_JSON_LANGUAGE: string = "json";
