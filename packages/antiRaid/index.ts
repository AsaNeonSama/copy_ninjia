/** Anti-Raid 主线程对外入口：汇总 Worker 生命周期控制、停机排空与 Telegram 更新接入函数。 */
export {
  clearAdDetection,
  clearFloodControl,
  deactivateJoinGuardChat,
  hydratePendingVerifications,
  initAntiRaid,
  syncAntiRaidAgentConfig,
  terminateAntiRaid,
} from "./workerBridge/controller";
export { drainAntiRaid } from "./durableDelivery";
export {
  handleChatMemberUpdate,
  handleAntiRaidMessageIngress,
  handleVerificationCallback,
} from "./updateIngress";
