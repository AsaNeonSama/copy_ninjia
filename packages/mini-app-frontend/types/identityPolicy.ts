/**
 * Mini App 前端使用的白名单权限类型副本：与 `packages/types/identityPolicy.ts` 同名声明一致，
 * 由 `test/miniApp/frontendParity.test.ts` 逐项核对。
 */

/** 白名单身份可被逐项授予的权限；字段名与 /permission 参数保持一致。 */
export interface WhitelistPermissions {
  isCanMute: boolean;
  isCanUnMute: boolean;
  isCanGag: boolean;
  isCanViewBotStatus: boolean;
  isCanBlock: boolean;
  isCanUnBlock: boolean;
  isCanWhiteOther: boolean;
  isCanSwitchMood: boolean;
  isCanBypassAdDetection: boolean;
  isCanBypassFloodControl: boolean;
  isCanControllAIPermission: boolean;
  isCanClearContext: boolean;
  isCanControllAdDetectPermission: boolean;
  isCanControllFloodControlPermission: boolean;
  isCanControllTranslatePermission: boolean;
  isCanControllAntiRaidPermission: boolean;
  isCanControllQaPermission: boolean;
  isCanAddHImage: boolean;
}

/** /permission 接受的权限键。 */
export type WhitelistPermissionKey = keyof WhitelistPermissions;
