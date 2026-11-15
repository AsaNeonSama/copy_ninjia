/**
 * Mini App 服务端对外公共入口：导出 HTTP 源站启停、路由处理、二次认证会话与 TOTP 存储，以及原生身份选择器接入钩子。
 */

export {
  issueMiniAppAuthSession,
  resolveAndRefreshMiniAppAuthSession,
} from "./auth/session";
export { loadMiniAppTotpRecord } from "./auth/totpStorage";
export { prepareMiniAppPicker } from "./picker/prepare";
export { getMiniAppPickerResult } from "./picker/sessions";
export { handleMiniAppSharedMessage } from "./picker/sharedMessage";
export { createMiniAppBunRoutes, handleMiniAppHttpRequest } from "./server/register";
export { startMiniAppServer, stopMiniAppServer } from "./server/serve";
