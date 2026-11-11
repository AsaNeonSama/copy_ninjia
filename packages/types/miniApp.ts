/**
 * Mini App 服务端类型兼容聚合入口，仅供 `test/mini-app-frontend/frontendParity.test.ts` 对拍使用；
 * 生产代码与其余测试直接导入 `types/miniApp/<domain>` 子模块。
 */
export type * from "./miniApp/auth";
export type * from "./miniApp/chats";
export type * from "./miniApp/gallery";
export type * from "./miniApp/identities";
export type * from "./miniApp/server";
