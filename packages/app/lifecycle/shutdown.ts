import type {
  FlushResult,
  FlushTimeouts,
  OwnerInitFlags,
  OwnerSettler,
  OwnerShutdownResults,
  ShutdownOutcome,
  ShutdownResults,
} from "../../types/lifecycle";
import { budgetWithinDeadline } from "../../libs/monotonicDeadline";
import type { ApplicationLifecycleDependencies } from "../lifecycleDependencies";

/**
 * 停机阶段各持久化与后台 owner 的固定排空、关闭、终止顺序及失败隔离（归属 `packages/app/lifecycle.ts`）。
 * 单个 owner 抛错仅记入对应失败结果，不中断后续 owner 排空与最终状态落盘。
 * @see ../../../docs/cn/04-invariants.md
 */

/**
 * 绑定一份 logger，生成本次停机使用的失败隔离器。
 * @param logger 应用生命周期使用的日志记录器。
 * @returns 封装 flush、gate 与 terminate 三类失败隔离调用的结算器。
 */
export function createOwnerSettler(logger: ApplicationLifecycleDependencies["logger"]): OwnerSettler {
  async function settle<T>(owner: string, run: () => Promise<T>, onFailure: T): Promise<T> {
    try {
      return await run();
    } catch (error: unknown) {
      logger.error(`Shutdown owner ${owner} threw during disposal:`, error);
      return onFailure;
    }
  }
  return {
    flush: (owner: string, run: () => Promise<FlushResult>): Promise<FlushResult> => settle<FlushResult>(owner, run, "failed"),
    gate: (owner: string, run: () => Promise<boolean>): Promise<boolean> => settle<boolean>(owner, run, false),
    terminate: (owner: string, run: () => Promise<void>): Promise<FlushResult> => settle<FlushResult>(owner, async (): Promise<FlushResult> => {
      await run();
      return "flushed";
    }, "failed"),
  };
}

/**
 * 排空阶段的结果字段；`terminate` 与 `state` 不在其中，它们由调用方按各自语义
 * 单独收束（`terminate` 仅在 `dispose()` 的 `runShutdownOwners` 发生；`state` 则在
 * `flushAllToDisk` 与 `runShutdownOwners` 的末尾各自独立执行）。
 */
type OwnerDrainResults = Omit<OwnerShutdownResults, "terminate" | "state">;

/** 仅 dispose() 执行的、紧跟在某个 owner 排空之后的收尾步骤。 */
type ShutdownOwnerClose =
  | {
    /** 结果并进该 owner 自己的字段（排空成功但关闭失败，这个 owner 就不算干净）。 */
    readonly kind: "flush";
    /** 失败隔离与诊断日志里的关闭步骤名称。 */
    readonly label: string;
    /** 执行带超时预算的落盘型关闭步骤。 */
    readonly run: (
      dependencies: ApplicationLifecycleDependencies,
      timeoutMs: number
    ) => Promise<FlushResult>;
  }
  | {
    /** 结果并进 terminate 汇总（失败不影响已落盘的数据，但要反映在退出码上）。 */
    readonly kind: "terminate";
    /** 失败隔离与诊断日志里的终止步骤名称。 */
    readonly label: string;
    /** 执行终止型关闭步骤。 */
    readonly run: (dependencies: ApplicationLifecycleDependencies) => Promise<void>;
  };

/** 一个按固定顺序排空的停机 owner。 */
interface ShutdownDrainOwner {
  /** 对应的结果字段名；纯内存/状态机消息清理类 owner 不参与共享数据落盘闸门，设为 `null`。 */
  readonly result: keyof OwnerDrainResults | null;
  /** 失败隔离与诊断日志里的 owner 名。 */
  readonly label: string;
  /** 取哪一档时间预算。 */
  readonly timeout: keyof FlushTimeouts;
  /** 未初始化时整步跳过（视为 `flushed`）；终局 `close` 执行后重置回 `false`。 */
  readonly initFlag: keyof OwnerInitFlags | null;
  /** 执行该 owner 的排空动作。 */
  readonly drain: (
    dependencies: ApplicationLifecycleDependencies,
    timeoutMs: number,
    /** 是否为终局停机（`dispose()` 调用时为 `true`）。 */
    terminal: boolean
  ) => Promise<FlushResult>;
  /** 仅在终局停机（`terminal === true`）且排空结束后紧接执行的关闭或终止步骤。 */
  readonly close?: ShutdownOwnerClose;
}

/**
 * 停机排空 owner 的固定有序表：`flushAllToDisk`（确认最终 offset 前）与 `runShutdownOwners`（终局退出前）共用。
 * 顺序约束见 `docs/cn/04-invariants.md`：需发送或删除 Telegram 消息的 owner 均排在 Telegram 出站总闸之前，
 * 延迟删除排在 `antiRaid` 之后以一并清理排空期间补发的公告，AI 记忆刷盘排在 Disk I/O 刷盘之前。
 */
const SHUTDOWN_DRAIN_OWNERS: readonly Readonly<ShutdownDrainOwner>[] = [
  {
    result: "avatar",
    label: "avatar drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainAvatarUpdates(timeoutMs),
  },
  {
    result: "translate",
    label: "translate drain",
    timeout: "translateMs",
    initFlag: "translateInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainTranslate(timeoutMs),
    close: {
      kind: "flush",
      label: "translate close",
      run: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
        dependencies.closeTranslate(timeoutMs),
    },
  },
  {
    result: "antiRaid",
    label: "anti-raid drain",
    timeout: "antiRaidMs",
    initFlag: "antiRaidInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainAntiRaid(timeoutMs),
  },
  {
    // gag 提示消息由状态机在 Telegram 出站总闸关闭前主动删除，结果计入停机门禁。
    result: "gag",
    label: "gag drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainGagRuntime(timeoutMs),
  },
  {
    result: null,
    label: "qa form drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainQaForms(timeoutMs),
  },
  {
    result: "wed",
    label: "wed drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainWedRuntime(timeoutMs),
  },
  {
    result: null,
    label: "deferred commands drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainDeferredCommandRuntime(timeoutMs),
  },
  {
    result: null,
    label: "cron drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainCronScheduler(timeoutMs),
  },
  {
    result: null,
    label: "target message deletion drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainTargetMessageDeletions(timeoutMs),
  },
  {
    result: null,
    label: "Telegram delayed deletion drain",
    timeout: "maintenanceMs",
    initFlag: null,
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.drainPendingMessageDeletions(timeoutMs),
  },
  {
    result: "ai",
    label: "AI memory flush",
    timeout: "aiMemoryMs",
    initFlag: "aiChatInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.flushAiMemory(timeoutMs),
    close: {
      kind: "terminate",
      label: "AI chat termination",
      run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateAiChat(),
    },
  },
  {
    result: "telegram",
    label: "Telegram outbound drain",
    timeout: "maintenanceMs",
    initFlag: null,
    // 仅终局停机（terminal 为 true）关闭出站总闸；非终局路径保留总闸开启供最终 offset 确认请求使用。
    drain: (
      dependencies: ApplicationLifecycleDependencies,
      timeoutMs: number,
      terminal: boolean
    ): Promise<FlushResult> => dependencies.drainTelegramOutbound(timeoutMs, { quiesce: terminal }),
  },
  {
    result: "disk",
    label: "disk I/O flush",
    timeout: "diskIOMs",
    initFlag: "diskIOInitialized",
    drain: (dependencies: ApplicationLifecycleDependencies, timeoutMs: number): Promise<FlushResult> =>
      dependencies.flushDiskIO(timeoutMs),
  },
];

/** 全部排空完成后由终局 `dispose()` 依次执行的 Worker 终止列表。 */
const SHUTDOWN_TERMINATION_OWNERS: readonly Readonly<{
  readonly label: string;
  readonly initFlag: keyof OwnerInitFlags;
  readonly run: (dependencies: ApplicationLifecycleDependencies) => Promise<void>;
}>[] = [
  {
    label: "anti-raid termination",
    initFlag: "antiRaidInitialized",
    run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateAntiRaid(),
  },
  {
    label: "disk I/O termination",
    initFlag: "diskIOInitialized",
    run: (dependencies: ApplicationLifecycleDependencies): Promise<void> => dependencies.terminateDiskIO(),
  },
];

/** 遍历排空 `SHUTDOWN_DRAIN_OWNERS` 所需的上下文参数。 */
interface DrainOwnersParams {
  /** 应用生命周期依赖集合。 */
  dependencies: ApplicationLifecycleDependencies;
  /** 各 owner 的初始化状态标志（终局时就地重置）。 */
  flags: OwnerInitFlags;
  /** 停机阶段的失败隔离器。 */
  settler: OwnerSettler;
  /** 各阶段的落盘与排空时间预算。 */
  timeouts: FlushTimeouts;
  /** 整段停机的单调总截止（见 SHUTDOWN_TOTAL_BUDGET_MS）。 */
  deadline: number;
  /** true 表示进程要退出的那一遍：执行 close 步骤、关闭 Telegram 闸门、重置 flag。 */
  terminal: boolean;
}

/**
 * 一次走完 SHUTDOWN_DRAIN_OWNERS，返回各 owner 结果与终止型步骤的汇总。
 * 每次排空与 close 的等待在开始时取该 owner 的预算与总截止剩余时间的较小值。
 * @param params 排空各 owner 所需的依赖、初始化标志、失败隔离器、时间预算、总截止与终局标记。
 * @returns 包含各排空 owner 结果与终止步骤汇总结果的对象。
 */
async function drainOwners({
  dependencies,
  flags,
  settler,
  timeouts,
  deadline,
  terminal,
}: DrainOwnersParams): Promise<{ results: OwnerDrainResults; terminate: FlushResult }> {
  const results: OwnerDrainResults = {
    avatar: "flushed",
    translate: "flushed",
    gag: "flushed",
    wed: "flushed",
    antiRaid: "flushed",
    ai: "flushed",
    telegram: "flushed",
    disk: "flushed",
  };
  let terminate: FlushResult = "flushed";

  for (const owner of SHUTDOWN_DRAIN_OWNERS) {
    if (owner.initFlag !== null && !flags[owner.initFlag]) continue;
    const drainBudgetMs: number =
      budgetWithinDeadline(timeouts[owner.timeout], deadline, dependencies.monotonicNow);
    let result: FlushResult = await settler.flush(
      owner.label,
      (): Promise<FlushResult> => owner.drain(dependencies, drainBudgetMs, terminal)
    );
    // close 只在终局那一遍执行。
    if (terminal && owner.close !== undefined) {
      if (owner.close.kind === "flush") {
        const closeStep: Extract<ShutdownOwnerClose, { kind: "flush" }> = owner.close;
        const closeBudgetMs: number =
          budgetWithinDeadline(timeouts[owner.timeout], deadline, dependencies.monotonicNow);
        const closed: FlushResult = await settler.flush(
          closeStep.label,
          (): Promise<FlushResult> => closeStep.run(dependencies, closeBudgetMs)
        );
        if (result === "flushed" && closed !== "flushed") result = closed;
      } else {
        const closeStep: Extract<ShutdownOwnerClose, { kind: "terminate" }> = owner.close;
        const closed: FlushResult = await settler.terminate(
          closeStep.label,
          (): Promise<void> => closeStep.run(dependencies)
        );
        if (closed !== "flushed") terminate = closed;
      }
      if (owner.initFlag !== null) flags[owner.initFlag] = false;
    }
    if (owner.result !== null) results[owner.result] = result;
  }

  return { results, terminate };
}

/** 进程终局停机阶段执行全部 owner 排空、关闭、终止与状态落盘的上下文参数。 */
export interface RunShutdownOwnersParams {
  /** 应用生命周期依赖集合。 */
  dependencies: ApplicationLifecycleDependencies;
  /** 就地更新：终止过的 owner 置回 false。 */
  flags: OwnerInitFlags;
  /** 停机阶段的失败隔离器。 */
  settler: OwnerSettler;
  /** 各阶段的落盘与排空时间预算。 */
  timeouts: FlushTimeouts;
  /** 整段停机的单调总截止（见 SHUTDOWN_TOTAL_BUDGET_MS）。 */
  deadline: number;
  /** 未持锁时不写 state。 */
  lockAcquired: boolean;
}

/**
 * 按 SHUTDOWN_DRAIN_OWNERS 的固定顺序收尾，再终止 Anti-Raid / Disk I/O，最后
 * flush StateStore。与 flushAllToDisk 的差别：执行 close 步骤、关闭
 * Telegram 出站闸门、由参数显式传入持锁状态并在 `flushStateToDisk` 传入 `terminal = true`。
 * 排空与 state flush 的等待受总截止约束，终止型步骤照常执行、不按总截止缩短。
 * @param params 终局停机所需的依赖、初始化标志、失败隔离器、时间预算、总截止与持锁状态。
 * @returns 每个 owner 的结算结果；不抛错，异常一律折算进结果。
 */
export async function runShutdownOwners({
  dependencies,
  flags,
  settler,
  timeouts,
  deadline,
  lockAcquired,
}: RunShutdownOwnersParams): Promise<OwnerShutdownResults> {
  const { results, terminate: closeTerminate }: {
    results: OwnerDrainResults;
    terminate: FlushResult;
  } = await drainOwners({ dependencies, flags, settler, timeouts, deadline, terminal: true });

  // 终止型 owner 的失败单独汇总：它们排在各自 flush 之后，反映在退出码与实例锁处置上。
  let terminate: FlushResult = closeTerminate;
  for (const owner of SHUTDOWN_TERMINATION_OWNERS) {
    if (!flags[owner.initFlag]) continue;
    const result: FlushResult = await settler.terminate(
      owner.label,
      (): Promise<void> => owner.run(dependencies)
    );
    if (result !== "flushed") terminate = result;
    flags[owner.initFlag] = false;
  }

  const stateBudgetMs: number = budgetWithinDeadline(timeouts.stateMs, deadline, dependencies.monotonicNow);
  const state: FlushResult = lockAcquired
    ? await settler.flush("state flush", (): Promise<FlushResult> => dependencies.flushStateToDisk(stateBudgetMs, true))
    : "flushed";

  return { ...results, terminate, state };
}

/**
 * 本次停机每个会写共享数据的 owner 是否都干净收尾。
 * 不看 `offsetConfirmed`（它只决定 Telegram 是否重投），处置差异见 classifyShutdown。
 * @param results 本次停机汇总的各阶段结算结果。
 * @returns 所有涉及共享数据的阶段均干净完成时返回 `true`，否则返回 `false`。
 */
function allOwnersSettled(results: ShutdownResults): boolean {
  return results.runnerDrained &&
    results.maintenanceSettled &&
    results.avatar === "flushed" &&
    results.translate === "flushed" &&
    results.gag === "flushed" &&
    results.wed === "flushed" &&
    results.antiRaid === "flushed" &&
    results.ai === "flushed" &&
    results.telegram === "flushed" &&
    results.disk === "flushed" &&
    results.terminate === "flushed" &&
    results.state === "flushed";
}

/**
 * 将停机汇总结果归类为 `"clean"`、`"offsetWithheld"` 或 `"unsettled"`（语义见 `types/lifecycle.ts` 的 `ShutdownOutcome`）。
 * 只要当前 `results` 中全部共享数据与终止阶段均已完成，即便 `wait()` 期间未完成最终 offset 确认，
 * 也归类为 `"offsetWithheld"`（释放单实例锁、等待重启重投），否则归类为 `"unsettled"`（扣住单实例锁）。
 * @param results 本次停机汇总的各阶段结算结果。
 * @returns 停机分类结果（`"clean"`、`"offsetWithheld"` 或 `"unsettled"`）。
 */
export function classifyShutdown(results: ShutdownResults): ShutdownOutcome {
  if (!allOwnersSettled(results)) return "unsettled";
  return results.offsetConfirmed ? "clean" : "offsetWithheld";
}

/**
 * 各 owner 排空结果的诊断片段，字段顺序固定；停机结果与确认 offset 前的结果共用。
 * @param results 各排空 owner 的结算结果。
 * @returns 按固定字段顺序拼装的单行英文诊断片段。
 */
function formatOwnerDrainResults(results: OwnerDrainResults): string {
  return `avatar=${results.avatar}, translate=${results.translate}, gag=${results.gag}, wed=${results.wed}, ` +
    `antiRaid=${results.antiRaid}, ai=${results.ai}, telegram=${results.telegram}, disk=${results.disk}`;
}

/**
 * 停机结果的单行诊断文案（英文，见 AGENTS.md 日志约定）。
 * @param results 本次停机汇总的各阶段结算结果。
 * @returns 包含全部停机阶段状态的单行英文诊断字符串。
 */
export function formatShutdownResults(results: ShutdownResults): string {
  return `runner=${results.runnerDrained}, maintenance=${results.maintenanceSettled}, ` +
    `offset=${results.offsetConfirmed}, ${formatOwnerDrainResults(results)}, ` +
    `terminate=${results.terminate}, state=${results.state}`;
}

/** 确认最终 Telegram offset 前执行全量排空与落盘的上下文参数。 */
export interface FlushAllToDiskParams {
  /** 应用生命周期依赖集合。 */
  dependencies: ApplicationLifecycleDependencies;
  /** 各 owner 的初始化状态标志。 */
  flags: OwnerInitFlags;
  /** 停机阶段的失败隔离器。 */
  settler: OwnerSettler;
  /** 各阶段的落盘与排空时间预算。 */
  timeouts: FlushTimeouts;
  /** 整段停机的单调总截止（见 SHUTDOWN_TOTAL_BUDGET_MS）。 */
  deadline: number;
}

/**
 * 确认最终 Telegram offset 之前的完整落盘：Worker mailbox 与主线程后台队列
 * 先归零，随后 flush 覆盖它们发布的最后一份镜像。owner 顺序与 runShutdownOwners
 * 共用 SHUTDOWN_DRAIN_OWNERS，差别只在于 `terminal: false`（不执行 close 步骤、不终止任何 Worker、
 * 不关闭 Telegram 出站闸门）；`dispose()` 随后再以 `terminal: true` 完整执行一遍排空、关闭与终止。
 * 各步等待受总截止约束。
 * @param params 确认最终 offset 前落盘所需的依赖、初始化标志、失败隔离器、时间预算与总截止。
 * @returns 是否全部干净落盘；false 时调用方不得确认 offset。
 */
export async function flushAllToDisk({
  dependencies,
  flags,
  settler,
  timeouts,
  deadline,
}: FlushAllToDiskParams): Promise<boolean> {
  const { results }: { results: OwnerDrainResults } = await drainOwners({
    dependencies,
    flags,
    settler,
    timeouts,
    deadline,
    terminal: false,
  });
  const stateBudgetMs: number = budgetWithinDeadline(timeouts.stateMs, deadline, dependencies.monotonicNow);
  const state: FlushResult = await settler.flush(
    "state flush",
    (): Promise<FlushResult> => dependencies.flushStateToDisk(stateBudgetMs, false)
  );

  const unsettled: boolean = state !== "flushed" ||
    Object.values(results).some((result: FlushResult): boolean => result !== "flushed");
  if (unsettled) {
    process.exitCode = 1;
    dependencies.logger.error(
      `Pre-confirmation drain/flush results: ${formatOwnerDrainResults(results)}, state=${state}; ` +
      "the final Telegram update offset will not be confirmed."
    );
    return false;
  }
  return true;
}
