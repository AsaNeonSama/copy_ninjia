/**
 * Mini App 二次认证会话兼容入口：汇总会话查找与 IV 核验（`sessionLookup.ts`）、两阶段提交与滑动轮换（`sessionCommit.ts`）以及签发、吊销与续期响应头（`sessionLifecycle.ts`）。
 */

export { commitMiniAppSessionAccess } from "./sessionCommit";
export type {
  CommitMiniAppSessionAccessOptions,
  CommitMiniAppSessionAccessResult,
  CommittedMiniAppSessionState,
} from "./sessionCommit";
export {
  attachRefreshedSessionHeaders,
  clearAllMiniAppAuthSessions,
  clearPendingMiniAppSessionKey,
  issueMiniAppAuthSession,
  revokeMiniAppAuthSession,
  revokeMiniAppAuthSessionByLineage,
  revokeOtherMiniAppAuthSessions,
} from "./sessionLifecycle";
export {
  evaluateMiniAppSessionRequestIvs,
  findActiveMiniAppAuthSession,
  hasActiveMiniAppAuthSession,
  hasActiveMiniAppAuthSessionByLineage,
  lookupMiniAppSessionState,
} from "./sessionLookup";
export type {
  LookedUpMiniAppSessionState,
  MiniAppSessionRequestIvCheckResult,
} from "./sessionLookup";
