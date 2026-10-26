import type { WhitelistPermissionKey } from "../types/identityPolicy";
import { exhaustiveList } from "./exhaustiveList";

/**
 * 白名单权限抽屉与名单页逐项展示的权限键全集。
 * 不变量：与 `WhitelistPermissionKey` 联合类型一一对应；顺序与取值与 `packages/consts/whitelist.ts` 同名常量一致，由 `test/mini-app-frontend/frontendParity.test.ts` 核对。所属模块：`packages/mini-app-frontend/components/PermissionDrawer.tsx` 与 `packages/mini-app-frontend/components/IdentitiesTab.tsx`。
 */
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
