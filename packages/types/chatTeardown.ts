export type ChatRuntimeOwner = "copy" | "translate" | "gag" | "deleteMessage" | "aiChat" | "antiRaid" | "qa" | "wed" | "joinLog";
/**
 * 一次群 teardown 的起因，决定 owner 是只停运行态还是连同本群持久化数据一并删除。
 *
 * - `explicitDisable`：超级管理员 `/init disable`。机器人仍在群里、仍可调 API，
 *   验证按钮等残留消息当场删除；本群的持久化数据全部清除。
 * - `departed`：机器人被移出群（left/kicked，或启动时确证已不是成员）。持久化数据全部
 *   清除，不再发出任何出站 API；私密模式记录保留，等机器人回到群里再把权限还回去。
 * - `gone`：群已不存在（普通群升级为超级群后的旧 id，或启动时确证 `chat not found`）。
 *   在 `departed` 的基础上连私密模式记录一并放弃。
 * - `lostAuthority`：机器人仍在群里、被撤销管理员。只停运行态，本群的配置、成员集合、
 *   入群日志与问答保留；AI 记忆由 aiChat owner 在任何一次 teardown 里一并删除。
 *
 * 各 owner 经 libs/chatTeardown.ts 的 purgesChatData、isChatUnreachable 与 abandonsLockdown
 * 判定，不手写字面量比较（见 docs/cn/04-invariants.md 的群 teardown）。
 */
export type ChatTeardownReason = "explicitDisable" | "departed" | "gone" | "lostAuthority";

/** 机器人已离开群或群已不存在时的收尾起因，见 infra/botAdmin.ts 的 completeChatDeparture。 */
export type ChatDepartureReason = Extract<ChatTeardownReason, "departed" | "gone">;
export type ChatTeardownCallback = (
  chatId: number,
  reason: ChatTeardownReason
) => void | Promise<void>;
