/**
 * Disk I/O Worker 的共享 SQLite 门面。
 *
 * 连接恢复、群状态、群问答、身份策略、临时广告免检、待踢 outbox、AI 上下文、统一事务提交、镜像重放暂挂与停机关库分别由同名子目录模块
 * 实现；本文件只稳定消息路由所需的公开入口，不持有状态或复制领域逻辑。
 */

export { handleChatQaWrite } from "./storageDatabase/chatQa";
export { handleChatStateWrite } from "./storageDatabase/chatState";
export {
  collectStorageDatabaseFailures,
  flushStorageDatabase,
} from "./storageDatabase/flush";
export { setStorageFlushHold } from "./storageDatabase/flushHold";
export { adoptStorageDatabase, inspectStorageDatabase } from "./storageDatabase/hydration";
export {
  handleIdentityPolicyWrite,
  readBlocklistIdPage,
  readIdentityPolicies,
} from "./storageDatabase/identityPolicy";
export { handleBlocklistRemovalWrite } from "./storageDatabase/pendingRemoval";
export { closeStorageDatabaseForShutdown } from "./storageDatabase/shutdown";
export {
  handleTemporaryAdBypassWrite,
  maintainTemporaryAdBypassActivities,
} from "./storageDatabase/temporaryAdBypass";
