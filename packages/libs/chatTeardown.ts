import type { ChatTeardownReason } from "../types/chatTeardown";

/**
 * 本次 teardown 是否要连同本群的持久化数据一并删除。
 *
 * `explicitDisable`（`/init disable`）、`departed`（被移出群）与 `gone`（群已不存在）删除本群的
 * `/wed` 成员集合、入群日志、问答与 `chat_states` 行；`lostAuthority`（仍在群里、被撤销
 * 管理员）只停运行态，这几项保留。
 *
 * AI 记忆不看这个判定：aiChat owner 在任何一次 teardown 里都删，口径与
 * `/ai_chat disable` 一致（见 aiChat/workerBridge.ts 的 registerChatTeardown）。
 *
 * 各 owner 经本函数判定是否删除数据，不手写 `reason === "..."`（见
 * docs/cn/04-invariants.md 的群 teardown）。
 */
export function purgesChatData(reason: ChatTeardownReason): boolean {
  return reason !== "lostAuthority";
}

/**
 * 本次 teardown 时机器人是否已无法在本群调用 Bot API：`departed`（被移出）与 `gone`（群已不存在）
 * 为 true。此时各 owner 不再删除群里的残留消息，只作废本地记的消息 id。
 */
export function isChatUnreachable(reason: ChatTeardownReason): boolean {
  return reason === "departed" || reason === "gone";
}

/**
 * 本次 teardown 是否连私密模式记录一起放弃：只有 `gone`（群已不存在）为 true。其余起因下
 * Anti-Raid Worker 照常落盘「要恢复」并重试还原权限（见 consts/antiRaid/lockdown.ts 的
 * RESTORE_PERMANENT_FAILURE_LOG_LIMIT）。
 */
export function abandonsLockdown(reason: ChatTeardownReason): boolean {
  return reason === "gone";
}
