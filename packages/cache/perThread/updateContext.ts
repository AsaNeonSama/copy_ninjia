/** owner: perThread。update 取消上下文（packages/infra/updateContext.ts）的逐线程存储。
 *
 * perThread：infra/telegram/actions/core.ts 经 infra/updateContext.ts 引入本模块，
 * 主线程、AI 闲聊 Worker 与 Anti-Raid Worker 各持一份互不相关的实例。只有主线程填入
 * 作用域：app/updateRunner.ts 为每条 update 填入信号与触发话题，infra/commandExecutor.ts
 * 在 /wed 与延迟命令（commands/wed/runtime.ts、commands/deferredCommands.ts）的任务出队时
 * 恢复接纳时的信号与话题；Worker 内的实例从不填入，读取恒为「不在 update 作用域内」。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { UpdateScope } from "../../types/lifecycle";

/**
 * 本线程唯一的 AsyncLocalStorage 实例；模块加载时创建，进程或 Worker 重建时随
 * isolate 重新创建。作用域由 run 建立，run 返回后调用方上下文随即退出，已派生的
 * 异步子任务继续持有各自的作用域，其结束后由 GC 释放；实例本身不保存条目，
 * 不需要淘汰或清空。
 */
export const updateScopeStorage: AsyncLocalStorage<UpdateScope> =
  new AsyncLocalStorage<UpdateScope>();
