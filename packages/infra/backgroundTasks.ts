import { logger } from "./logger";
import type { BackgroundTaskFailureLog } from "../types/logger";

/**
 * 各 owner 的后台任务（广告处置、延迟删除、延迟命令、wed 交互与成员复核、gag 提示）共用的错误边界。
 * 错误归一化后摘除任务；有界等待由 libs/inflight.ts 负责。
 */

/**
 * 把一条后台任务接入 owner 的在途集合，并在结算后自摘除。
 * @param tasks owner 持有的在途集合；本函数只增删自己登记的那一个条目。
 * @param task 已经启动的任务；异常只记一行日志，不逃出本边界。
 * @param failure 失败时写入错误日志的静态英文摘要（含冒号），或附带结构化上下文的日志对象。
 */
export function trackBackgroundTask(
  tasks: Set<Promise<void>>,
  task: Promise<unknown>,
  failure: string | BackgroundTaskFailureLog
): void {
  const observed: Promise<void> = task.then(
    (): void => {
      tasks.delete(observed);
    },
    (error: unknown): void => {
      tasks.delete(observed);
      if (typeof failure === "string") logger.error(failure, error);
      else logger.error(failure.message, failure.context, error);
    }
  );
  tasks.add(observed);
}
