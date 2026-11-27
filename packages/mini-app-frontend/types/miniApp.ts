/**
 * Mini App 前端类型兼容聚合入口，仅供 `test/mini-app-frontend/frontendParity.test.ts` 对拍与测试使用；
 * 前端生产代码直接导入 `types/miniApp/<domain>` 与 `types/miniAppConfigs` 领域模块。
 */
export type * from "./miniApp/adBlacklists";
export type * from "./miniApp/auth";
export type * from "./miniApp/chats";
export type * from "./miniApp/gallery";
export type * from "./miniApp/host";
export type * from "./miniApp/identities";
export type * from "./miniApp/status";
export type * from "./miniApp/ui";
export type * from "./miniAppConfigs";
