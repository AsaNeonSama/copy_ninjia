/** owner: main。`/wed` 按钮会话、在途头像探测与命令执行器（packages/commands/wed/）。 */
import type { CommandExecutorRuntime } from "../../types/commandExecutor";
import type { WedAvatarProbe, WedChat } from "../../types/wed";

/**
 * 群 ID 到 `/wed` 交互会话容器的映射：群首次建立交互时填充（引用 wedMembers.ts 的成员池），移除按钮、重开或群 teardown 时清理会话并取消在途操作。
 * 群数上限为 STATE_MANAGED_CHAT_LIMIT，每群会话上限为 WED_SESSION_LIMIT（满额拒绝新建且不淘汰现有会话）；进程重启后从空表开始。
 */
export const wedChats: Map<number, WedChat> = new Map();

/**
 * 用户 ID 到在途头像探测集合的映射：抽取候选探测头像时登记（探测期间新发言追加群 ID），查询结算时移除。
 * 并发上限受 WED_MAX_CONCURRENT 约束，不淘汰；进程重启后从空表开始（无条目表示无在途探测）。
 */
export const wedAvatarProbes: Map<number, Set<WedAvatarProbe>> = new Map();

/**
 * `/wed` 命令执行器运行时单例：启动时由 initWedRuntime 创建（并发上限 WED_MAX_CONCURRENT，排队上限 WED_MAX_PENDING），群 teardown 撤销对应群等待项，停机时先 quiesce 取消每日复核再有界排空。
 * 进程重启后从 null 重新创建。
 */
export const wedRuntime: { current: CommandExecutorRuntime | null } = { current: null };
