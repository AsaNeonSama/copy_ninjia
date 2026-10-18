/** owner: main。延迟命令执行器状态（packages/commands/deferredCommands.ts）。 */

import type { CommandExecutorRuntime } from "../../types/commandExecutor";

/**
 * 延迟命令执行器运行时单例：initDeferredCommandRuntime 创建，任务入队时登记并在结算时移除；停机时先 quiesce 停止接纳，再在预算内排空或超时中止排队与在途任务。
 * 并发上限为 DEFERRED_COMMAND_MAX_CONCURRENT，排队上限为 DEFERRED_COMMAND_MAX_PENDING（后台档上限 DEFERRED_COMMAND_MAX_BACKGROUND_PENDING），满额拒绝新任务；进程重启后从 null 重新创建。
 */
export const deferredCommandRuntime: { current: CommandExecutorRuntime | null } = { current: null };
