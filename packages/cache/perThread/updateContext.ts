/** owner: perThread。Telegram update 取消信号与触发话题作用域存储（packages/infra/updateContext.ts）。 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { UpdateScope } from "../../types/lifecycle";

/**
 * 当前线程的 UpdateScope 异步上下文存储单例：主线程在 updateRunner 与 commandExecutor 执行期间通过 run 注入作用域，异步链路结束后自动释放（Worker 线程不注入，读取恒为 undefined）。
 * 单例实例，不保存持久条目、无需淘汰，进程或 Worker 重建时重新创建。
 */
export const updateScopeStorage: AsyncLocalStorage<UpdateScope> =
  new AsyncLocalStorage<UpdateScope>();
