import {
  RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
  RUNNER_DRAIN_TIMEOUT_MS,
} from "../../consts/lifecycle";
import { settleWithinBudget } from "../../libs/inflight";
import {
  createMonotonicDeadline,
  remainingMonotonicTime,
} from "../../libs/monotonicDeadline";
import type { AcknowledgedUpdateRunner } from "../../types/lifecycle";
import type { ApplicationLifecycleDependencies } from "../lifecycleDependencies";

/**
 * 依次静默所有在停机排空期间可能继续产生新任务的后台维护入口（幂等）。
 * 每个入口独立捕获异常，前一项失败不阻断后续入口关闸。
 * @param dependencies 应用生命周期依赖集合。
 * @returns 全部入口均未抛错时返回 `true`，否则返回 `false`。
 */
export function quiesceLifecycleMaintenance(
  dependencies: ApplicationLifecycleDependencies
): boolean {
  let succeeded: boolean = true;
  const quiesceOwner = (owner: string, run: () => void): void => {
    try {
      run();
    } catch (error: unknown) {
      succeeded = false;
      dependencies.logger.error("Shutdown owner quiesce threw during shutdown:", { owner }, error);
    }
  };
  quiesceOwner("avatar", (): void => dependencies.quiesceAvatarUpdates());
  quiesceOwner("chat-title", (): void => dependencies.quiesceChatTitleRefresh());
  quiesceOwner("translate", (): void => dependencies.quiesceTranslate());
  quiesceOwner("gag", (): void => dependencies.quiesceGagRuntime());
  quiesceOwner("wed", (): void => dependencies.quiesceWedRuntime());
  quiesceOwner("deferred-commands", (): void => dependencies.quiesceDeferredCommandRuntime());
  quiesceOwner("cron", (): void => dependencies.quiesceCronScheduler());
  quiesceOwner("blocklist-sweep", (): void =>
    dependencies.quiesceBlocklistSweepScheduler());
  quiesceOwner("config-reload", (): void => dependencies.quiesceConfigReload());
  return succeeded;
}

/**
 * 在给定单调预算内按事件驱动方式等待 runner 的在途 update 结算。
 * @param runner 已确认更新批处理 runner。
 * @param timeoutMs 等待预算毫秒数。
 * @param monotonicNow 单调时钟读取函数。
 * @returns 预算内 `runner.size()` 归零返回 `true`，预算耗尽或无在途结算句柄返回 `false`。
 */
async function waitForRunnerIdle(
  runner: AcknowledgedUpdateRunner,
  timeoutMs: number,
  monotonicNow: ApplicationLifecycleDependencies["monotonicNow"]
): Promise<boolean> {
  const deadline: number = createMonotonicDeadline(timeoutMs, monotonicNow);
  while (runner.size() > 0) {
    const remainingMs: number = remainingMonotonicTime(deadline, monotonicNow);
    if (remainingMs <= 0) return false;
    const task: Promise<void> | null = runner.activeTask();
    if (task === null) return false;
    if (!await settleWithinBudget([task], remainingMs)) return false;
    // 防御已结算句柄未归零 size() 时的空转。
    if (runner.size() > 0 && runner.activeTask() === task) return false;
  }
  return true;
}

/**
 * 在 RUNNER_DRAIN_TIMEOUT_MS 内等待 runner 排空；超时后取消在途 update，并区分取消是否真正结算。
 * @param runner 已确认更新批处理 runner。
 * @param dependencies 应用生命周期依赖集合。
 * @returns 自然排空返回 `"drained"`，超时后取消并结算返回 `"aborted"`，取消仍未结算返回 `"unsettled"`。
 */
export async function drainAcknowledgedUpdateRunner(
  runner: AcknowledgedUpdateRunner,
  dependencies: ApplicationLifecycleDependencies
): Promise<"drained" | "aborted" | "unsettled"> {
  if (await waitForRunnerIdle(runner, RUNNER_DRAIN_TIMEOUT_MS, dependencies.monotonicNow)) {
    return "drained";
  }

  const activeAtDeadline: number = runner.size();
  dependencies.logger.error(
    "Shutdown drain timed out with active updates; aborting them and withholding their Telegram offset.",
    { activeUpdates: activeAtDeadline, timeoutMs: RUNNER_DRAIN_TIMEOUT_MS }
  );
  runner.abortActive();
  if (await waitForRunnerIdle(runner, RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS, dependencies.monotonicNow)) {
    return "aborted";
  }

  dependencies.logger.error(
    "Active updates ignored shutdown cancellation; forcing a failed process exit after best-effort flush.",
    { activeUpdates: runner.size(), timeoutMs: RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS }
  );
  return "unsettled";
}

/**
 * 等待已启动的群标题维护任务；预算耗尽时先取消任务，再向停机门禁报告失败。
 * task 由 app/lifecycle.ts 在启动时接上 catch，结算即视为完成。
 * @param task 启动期挂出的群标题维护任务 Promise。
 * @param timeoutMs 等待结算的预算毫秒数（不大于 0 时直接取消）。
 * @param dependencies 应用生命周期依赖集合。
 * @returns 在预算内结算返回 `true`，超时或预算非正并已取消返回 `false`。
 */
export async function waitForLifecycleBackgroundMaintenance(
  task: Promise<void>,
  timeoutMs: number,
  dependencies: ApplicationLifecycleDependencies
): Promise<boolean> {
  if (timeoutMs <= 0) {
    // 没有等待窗口时同样 abort，预算耗尽后不再写入群标题。
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error("Skipping unfinished chat title refresh during emergency disposal; aborted it.");
    return false;
  }
  const settled: boolean = await settleWithinBudget([task], timeoutMs);
  if (!settled) {
    dependencies.abortChatTitleRefresh();
    dependencies.logger.error(
      "Chat title refresh did not settle within budget and was aborted.",
      { timeoutMs }
    );
  }
  return settled;
}
