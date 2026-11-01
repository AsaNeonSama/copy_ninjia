import {
  EMERGENCY_FLUSH_TIMEOUTS,
  EMERGENCY_REUSED_DISPOSE_DEADLINE_MS,
  FINAL_OFFSET_CONFIRM_TIMEOUT_MS,
  NORMAL_FLUSH_TIMEOUTS,
  SHUTDOWN_TOTAL_BUDGET_MS,
} from "../consts/lifecycle";
import { TELEGRAM_ALLOWED_UPDATES } from "../consts/telegram";
import type { CachedUser } from "../types/chatState";
import type { LoadedData } from "../types/diskIO/replies";
import type {
  AcknowledgedUpdateRunner,
  ApplicationRunMode,
  FlushResult,
  FlushTimeouts,
  HandlerRegistration,
  OwnerInitFlags,
  OwnerSettler,
  ShutdownOutcome,
  ShutdownResults,
} from "../types/lifecycle";
import { budgetWithinDeadline, createMonotonicDeadline } from "../libs/monotonicDeadline";
import { telegramSignal } from "../libs/telegramSignal";
import { lifecycleDependencies } from "./lifecycleDependencies";
import type { ApplicationLifecycleDependencies } from "./lifecycleDependencies";
import {
  classifyShutdown,
  createOwnerSettler,
  flushAllToDisk,
  formatShutdownResults,
  runShutdownOwners,
} from "./lifecycle/shutdown";
import {
  drainAcknowledgedUpdateRunner,
  quiesceLifecycleMaintenance,
  waitForLifecycleBackgroundMaintenance,
} from "./lifecycle/maintenance";

/** 触发应用优雅关停的进程信号名称。 */
type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * 持有应用从取得单实例锁到释放锁的完整生命周期。所有会联网、创建 Worker、
 * 注册进程 handler 或写盘的动作都由显式 init/run/dispose 驱动，模块导入本身
 * 不启动任何组件。
 * @see ../../docs/cn/04-invariants.md
 */
export class ApplicationLifecycle {
  constructor(private readonly dependencies: ApplicationLifecycleDependencies = lifecycleDependencies) {}

  private lockAcquired: boolean = false;
  // 各 owner 的初始化标志交给停机序列就地读写（见 lifecycle/shutdown.ts）：
  // 终止过的 owner 置回 false，不重复终止。
  private readonly flags: OwnerInitFlags = {
    aiChatInitialized: false,
    antiRaidInitialized: false,
    diskIOInitialized: false,
    translateInitialized: false,
  };
  private stopRequested: boolean = false;
  private runner: AcknowledgedUpdateRunner | null = null;
  private runnerTaskSettled: boolean = false;
  private handlers: HandlerRegistration | null = null;
  private chatTitleRefreshTask: Promise<void> | null = null;
  private chatTitleRefreshSettled: boolean = true;
  private disposePromise: Promise<void> | null = null;
  private processHandlersInstalled: boolean = false;
  private fatalExitStarted: boolean = false;
  private runnerCancellationUnsettled: boolean = false;
  /**
   * 最终 Telegram offset gate 的进程级闩锁。没有待确认 update 时保持 true；
   * wait() 一旦发现确认失败/超时或关键前置未完成，就永久置 false，后续 dispose 读取它。
   */
  private finalOffsetGateSucceeded: boolean = true;
  /** 整段停机的单调总截止（SHUTDOWN_TOTAL_BUDGET_MS）；首次停机请求或开始收尾时创建，此后不再改动。 */
  private shutdownDeadline: number | null = null;

  /**
   * 三条停机入口（信号、Disk I/O fatal、业务 Worker fatal）共用的停止动作：
   * 启动整段停机总截止、置位 stopRequested、静默维护任务，再请求 runner 停止取 update。
   * runner 停止失败只记一行日志，不上抛。
   * @param stopErrorMessage runner 停止失败时的日志前缀，按入口区分。
   */
  private stopForShutdown(stopErrorMessage: string): void {
    this.startShutdownDeadline();
    this.stopRequested = true;
    quiesceLifecycleMaintenance(this.dependencies);
    this.runner?.stop().catch((error: unknown): void => {
      this.dependencies.logger.error(stopErrorMessage, error);
    });
  }

  /**
   * 创建整段停机的单调总截止（SHUTDOWN_TOTAL_BUDGET_MS）；已创建时沿用首次的截止。
   * @returns 整段停机的单调总截止时间点。
   */
  private startShutdownDeadline(): number {
    this.shutdownDeadline ??= createMonotonicDeadline(SHUTDOWN_TOTAL_BUDGET_MS, this.dependencies.monotonicNow);
    return this.shutdownDeadline;
  }

  /**
   * 响应进程退出信号（`SIGINT` / `SIGTERM`），首次收到时打印日志并启动优雅关停。
   * @param signal 触发关停的信号名。
   */
  private stopOnSignal(signal: ShutdownSignal): void {
    if (!this.stopRequested) {
      this.dependencies.logger.log(`Received ${signal}; beginning graceful shutdown.`);
    }
    this.stopForShutdown("Error stopping runner:");
  }

  private readonly stopOnSigint = (): void => { this.stopOnSignal("SIGINT"); };
  private readonly stopOnSigterm = (): void => { this.stopOnSignal("SIGTERM"); };

  private readonly handleUncaughtException = (error: unknown): void => {
    this.dependencies.logger.error("Uncaught exception, attempting a best-effort flush before exit:", error);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleUnhandledRejection = (reason: unknown): void => {
    this.dependencies.logger.error("Unhandled rejection, attempting a best-effort flush before exit:", reason);
    this.exitAfterEmergencyDispose();
  };

  private readonly handleDiskIOFatal = (error: Error): void => {
    this.dependencies.logger.error("Persistence became unavailable at runtime; stopping for a supervised restart:", error);
    process.exitCode = 1;
    this.stopForShutdown("Error stopping runner after persistence failure:");
  };

  private readonly handleBusinessWorkerFatal = (error: Error): void => {
    this.dependencies.logger.error(
      "Business Worker became unavailable at runtime; stopping for a supervised restart:",
      error
    );
    process.exitCode = 1;
    this.stopForShutdown("Error stopping runner after business Worker failure:");
  };

  /** 初始化各组件并开始长轮询；重复调用会被拒绝。 */
  async init(): Promise<void> {
    if (this.runner !== null || this.lockAcquired) throw new Error("Application lifecycle is already initialized");

    await this.dependencies.acquireSingleInstanceLock(this.dependencies.BOT_TOKEN);
    this.lockAcquired = true;
    this.dependencies.setBusinessWorkerFatalHandler(this.handleBusinessWorkerFatal);
    this.dependencies.setStatePersistenceFatalHandler(this.handleDiskIOFatal);
    this.dependencies.initAvatarUpdates();
    this.dependencies.initChatTitleRefresh();
    this.dependencies.initTranslate();
    this.dependencies.initGagRuntime();
    this.dependencies.initWedRuntime();
    this.dependencies.initDeferredCommandRuntime();
    this.flags.translateInitialized = true;

    // 配置文件和持久化状态在启动边界按不可信部署输入严格校验。
    await this.dependencies.cleanupOrphanedTempFiles();
    await this.dependencies.loadState();
    await this.dependencies.validateExistingDeploymentInputs();
    await this.dependencies.prepareRandomImageDirectory();
    this.dependencies.initDiskIO({ onFatal: this.handleDiskIOFatal });
    this.flags.diskIOInitialized = true;

    const loaded: LoadedData = await this.dependencies.loadPersistedData();
    this.dependencies.hydrateChatStateCache(loaded.chatStates);
    this.dependencies.hydrateChatQaCache(loaded.chatQa);
    this.dependencies.hydrateWedMembers(loaded.wedMembers);
    this.dependencies.initTelegramClients();
    this.dependencies.hydrateIdentityStorageCounts(
      loaded.permissionEntryCount,
      loaded.blocklistEntryCount
    );
    // 超管与黑名单互斥：断言排在 hydrate 之后（hydrate 会清空身份 LRU）、
    // sweepManagedBlocklistChats 之前（见 infra/blocklist/membership.ts）。
    await this.dependencies.assertSuperAdminNotBlocked(
      this.dependencies.SUPER_ADMIN_USER_ID
    );
    // 超管与各群 /delete_message 目标互斥，读的是上面刚载入的群状态热读副本。
    this.dependencies.assertSuperAdminNotDeleteMessageTarget(
      this.dependencies.SUPER_ADMIN_USER_ID
    );
    const restoredCopiedUser: CachedUser | null = this.dependencies.getGlobalCopyState().copiedUser;
    if (restoredCopiedUser) this.dependencies.seedSenderCache(restoredCopiedUser);
    this.dependencies.seedTranslateTargets();
    this.dependencies.restoreLuckState(loaded.luckReceiptSecret, loaded.luckDay);
    this.dependencies.hydratePendingVerifications(loaded.verifications);

    this.handlers = this.dependencies.registerHandlers(this.dependencies.bot);
    await this.dependencies.registerCommandMenu(this.dependencies.bot);
    await this.dependencies.bot.init();

    this.dependencies.initAiChat(this.dependencies.bot.botInfo);
    this.flags.aiChatInitialized = true;
    this.dependencies.hydrateAiMemory(loaded.aiMemories);
    this.dependencies.hydrateStickerCatalog(loaded.stickerCatalogs);
    // 早于 runner 开始投喂更新。
    this.dependencies.hydrateBlocklist(loaded.pendingBlockedRemovals);
    this.dependencies.initAntiRaid();
    this.flags.antiRaidInitialized = true;
    // 定时任务按启动总闸接管的 cron.json 登记；先于热重载，热重载的对账改动该调度器。
    this.dependencies.startCronScheduler();
    // 两条业务 Worker 都已持有初始配置快照，此后 config/dynamic/ 的改动才有分发对象。
    this.dependencies.startConfigReload();
    this.dependencies.startMiniAppServer();
    this.dependencies.initBlocklistSweepScheduler();
    // 在 runner 接收新 update 前，对所有已初始化且已确证管理员的群补跑一轮黑名单清扫。
    await this.dependencies.sweepManagedBlocklistChats();

    this.dependencies.logger.log(
      `Bot started as @${this.dependencies.bot.botInfo.username}. ` +
      `Restored state for ${this.dependencies.getChatStateCache().size} chat(s)` +
      (restoredCopiedUser ? `, currently copying ${restoredCopiedUser.id}.` : ".")
    );

    this.runner = this.dependencies.runAcknowledgedUpdateBatches(
      this.dependencies.bot,
      TELEGRAM_ALLOWED_UPDATES
    );
    // 启动期到达的停止信号在各运行时初始化完成后重新收口，位于 refreshAllChatTitles 之前。
    if (this.stopRequested) this.stopForShutdown("Error stopping runner:");
    this.dependencies.enableWedMemberReview();
    this.chatTitleRefreshSettled = false;
    this.chatTitleRefreshTask = this.dependencies.refreshAllChatTitles()
      .catch((error: unknown): void => {
        this.dependencies.logger.error("Failed to complete chat title refresh:", error);
      })
      .finally((): void => { this.chatTitleRefreshSettled = true; });
  }

  /** 等待轮询停止、在途 update 排空、后台维护结束，并确认最终 update offset；各步等待受整段停机总截止约束。 */
  async wait(): Promise<void> {
    const runner: AcknowledgedUpdateRunner | null = this.runner;
    if (runner === null) throw new Error("Application lifecycle has not been initialized");

    try {
      await runner.task();
    } catch (error: unknown) {
      // task() 抛错时下面的最终 offset 确认整段跳过：这里把
      // finalOffsetGateSucceeded 置 false，dispose 据此判为 "offsetWithheld"。
      this.finalOffsetGateSucceeded = false;
      throw error;
    } finally {
      this.runnerTaskSettled = true;
    }
    const deadline: number = this.startShutdownDeadline();
    const maintenanceQuiesceSucceeded: boolean = quiesceLifecycleMaintenance(this.dependencies);
    await this.dependencies.stopMiniAppServer().catch((error: unknown): void => {
      this.dependencies.logger.error("Error stopping Mini App server during wait:", error);
    });
    const runnerDrained: boolean = await this.waitForRunnerDrain(runner);

    // 标题刷新可能排入 chatState SQLite 写缓冲，先等它完成，再做最终 flush。
    const maintenanceSettled: boolean = await this.waitForBackgroundMaintenance(
      budgetWithinDeadline(NORMAL_FLUSH_TIMEOUTS.maintenanceMs, deadline, this.dependencies.monotonicNow)
    );
    const persistenceFlushed: boolean = await this.flushAllToDisk(NORMAL_FLUSH_TIMEOUTS, deadline);
    if (!maintenanceQuiesceSucceeded || !runnerDrained || !maintenanceSettled) process.exitCode = 1;

    // 停机时取数循环放弃在途 update、不再 await 它的结算，之后发生的失败由
    // runner 的这个标记表达（task() 正常 resolve）。失败的 update 留给 Telegram
    // 重投，不随最终 offset 确认，见 docs/cn/04-invariants.md「Telegram update
    // 只有在对应 middleware 完成后才可推进确认边界」。读取位于 waitForRunnerDrain
    // 之后：标记与 size() 归零同步。
    const failedUpdateWithheld: boolean = runner.hasFailedUpdate();
    if (failedUpdateWithheld) {
      process.exitCode = 1;
      this.dependencies.logger.error(
        "Withholding the final Telegram offset: at least one update failed and must be redelivered after restart."
      );
    }
    const lastSeenUpdateId: number = this.handlers?.getLastSeenUpdateId() ?? 0;
    const confirmationPrerequisitesMet: boolean =
      maintenanceQuiesceSucceeded &&
      runnerDrained &&
      maintenanceSettled &&
      persistenceFlushed &&
      !failedUpdateWithheld;
    if (lastSeenUpdateId > 0 && confirmationPrerequisitesMet) {
      const offsetConfirmBudgetMs: number =
        budgetWithinDeadline(FINAL_OFFSET_CONFIRM_TIMEOUT_MS, deadline, this.dependencies.monotonicNow);
      try {
        await this.dependencies.bot.api.getUpdates(
          { offset: lastSeenUpdateId + 1, limit: 1, timeout: 0 },
          telegramSignal(AbortSignal.timeout(offsetConfirmBudgetMs))
        );
      } catch (error: unknown) {
        this.finalOffsetGateSucceeded = false;
        process.exitCode = 1;
        this.dependencies.logger.error("Failed to confirm update offset on shutdown:", error);
      }
    } else if (lastSeenUpdateId > 0) {
      this.finalOffsetGateSucceeded = false;
      process.exitCode = 1;
      this.dependencies.logger.error(
        "Withholding the final Telegram offset because a shutdown prerequisite did not settle cleanly."
      );
    }
  }

  /**
   * 停止活动 runner，等待后台任务完成，排空持久化并释放单实例锁；各步等待受整段停机总截止约束。
   * @param timeouts 各停机阶段的超时预算，默认使用常规关停预算。
   * @returns 停机排空与锁释放流程完成的 Promise（重复调用复用首次 Promise）。
   */
  dispose(timeouts: FlushTimeouts = NORMAL_FLUSH_TIMEOUTS): Promise<void> {
    this.disposePromise ??= (async (): Promise<void> => {
      const deadline: number = this.startShutdownDeadline();
      const settler: OwnerSettler = createOwnerSettler(this.dependencies.logger);
      const maintenanceQuiesceSucceeded: boolean = quiesceLifecycleMaintenance(this.dependencies);
      await this.dependencies.stopMiniAppServer().catch((error: unknown): void => {
        this.dependencies.logger.error("Error stopping Mini App server during disposal:", error);
      });
      const runner: AcknowledgedUpdateRunner | null = this.runner;
      if (runner !== null && !this.runnerTaskSettled) {
        await runner.stop().catch((error: unknown): void => {
          this.dependencies.logger.error("Error stopping runner during disposal:", error);
        });
      }
      const runnerDrained: boolean = runner === null
        ? true
        : await settler.gate("runner drain", (): Promise<boolean> => this.waitForRunnerDrain(runner));
      const backgroundMaintenanceSettled: boolean = await settler.gate(
        "background maintenance",
        (): Promise<boolean> => this.waitForBackgroundMaintenance(
          budgetWithinDeadline(timeouts.maintenanceMs, deadline, this.dependencies.monotonicNow)
        )
      );
      const results: ShutdownResults = {
        runnerDrained,
        maintenanceSettled: maintenanceQuiesceSucceeded && backgroundMaintenanceSettled,
        offsetConfirmed: this.finalOffsetGateSucceeded,
        ...await runShutdownOwners({
          dependencies: this.dependencies,
          flags: this.flags,
          settler,
          timeouts,
          deadline,
          lockAcquired: this.lockAcquired,
        }),
      };
      try {
        this.dependencies.setBusinessWorkerFatalHandler(undefined);
        this.dependencies.setStatePersistenceFatalHandler(undefined);
      } catch (error: unknown) {
        this.dependencies.logger.error("Shutdown owner fatal-handler teardown threw during disposal:", error);
      }
      // 结果分 clean / offsetWithheld / unsettled（见 lifecycle/shutdown.ts 的
      // classifyShutdown）：非 clean 报非零退出并打印诊断行；只有 unsettled 扣住实例锁。
      const outcome: ShutdownOutcome = classifyShutdown(results);
      if (outcome !== "clean") {
        process.exitCode = 1;
        this.dependencies.logger.error(`Shutdown drain/flush results: ${formatShutdownResults(results)}.`);
      }
      if (!this.lockAcquired) return;
      if (outcome === "unsettled") {
        this.dependencies.logger.error(
          "Retaining the single-instance lock until process exit because a task did not drain or persistence did not flush."
        );
        return;
      }
      if (outcome === "offsetWithheld") {
        // 锁照常释放：所有 owner 都已排空落盘、Worker 已终止。日志说明 offset
        // 未确认，重启后 Telegram 重投上次确认点之后的更新。
        this.dependencies.logger.error(
          "Releasing the single-instance lock even though the final Telegram offset was not confirmed: " +
          "every owner drained and flushed, so expect redelivery after restart rather than a persistence problem."
        );
      }
      const released: FlushResult = await settler.terminate(
        "single-instance lock release",
        (): Promise<void> => this.dependencies.releaseSingleInstanceLock(this.dependencies.BOT_TOKEN)
      );
      if (released !== "flushed") {
        process.exitCode = 1;
        return;
      }
      this.lockAcquired = false;
    })();
    return this.disposePromise;
  }

  /**
   * 执行 init/wait 并保证 dispose。main 模式额外接管进程 handler
   * 与退出码；test 模式把运行异常原样交还调用方。
   * @param mode 运行模式（`"main"` 接管进程信号与退出码，`"test"` 原样向上抛错）。
   */
  async run(mode: ApplicationRunMode): Promise<void> {
    const managesProcess: boolean = mode === "main";
    if (managesProcess) this.installProcessHandlers();

    try {
      await this.runMain();
    } catch (error: unknown) {
      if (!managesProcess) throw error;
      this.dependencies.logger.error("Unhandled error in bot main runner:", error);
      process.exitCode = 1;
    } finally {
      await this.dispose();
      if (managesProcess) {
        this.removeProcessHandlers();
        if (this.runnerCancellationUnsettled) process.exit(1);
      }
    }
  }

  /** 依次完成启动初始化与主循环阻塞等待。 */
  private async runMain(): Promise<void> {
    await this.init();
    await this.wait();
  }

  /** 注册进程信号与未捕获异常/拒绝监听器（幂等）。 */
  private installProcessHandlers(): void {
    if (this.processHandlersInstalled) return;
    // 信号 handler 在第一个 await 之前安装；信号在 runner 创建前到达时，
    // stopRequested 使 runner 一创建就停止。监听保持到 dispose 摘除，重复信号
    // 落到幂等的 stopOnSignal。
    process.on("SIGINT", this.stopOnSigint);
    process.on("SIGTERM", this.stopOnSigterm);
    process.on("uncaughtException", this.handleUncaughtException);
    process.on("unhandledRejection", this.handleUnhandledRejection);
    this.processHandlersInstalled = true;
  }

  /** 移除已注册的进程信号与未捕获异常/拒绝监听器（幂等）。 */
  private removeProcessHandlers(): void {
    if (!this.processHandlersInstalled) return;
    process.removeListener("SIGINT", this.stopOnSigint);
    process.removeListener("SIGTERM", this.stopOnSigterm);
    process.removeListener("uncaughtException", this.handleUncaughtException);
    process.removeListener("unhandledRejection", this.handleUnhandledRejection);
    this.processHandlersInstalled = false;
  }

  /** 在未捕获异常或未处理拒绝发生时触发紧急落盘，并在完成或硬截止超时后以退出码 1 退出进程。 */
  private exitAfterEmergencyDispose(): void {
    if (this.fatalExitStarted) return;
    this.fatalExitStarted = true;
    const reusesActiveDisposal: boolean = this.disposePromise !== null;
    let exitRequested: boolean = false;
    let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const exitWithFailure = (): void => {
      if (exitRequested) return;
      exitRequested = true;
      process.exit(1);
    };

    // disposePromise 固定首次调用的预算：普通关停已在途时，传入紧急预算不缩短它。
    // 仅在复用分支设置独立绝对截止；该 timer 保持 ref，清理卡死时仍执行最后的强制退出。
    if (reusesActiveDisposal) {
      hardDeadlineTimer = setTimeout((): void => {
        this.dependencies.logger.error(
          `Emergency shutdown exceeded the ${EMERGENCY_REUSED_DISPOSE_DEADLINE_MS}ms hard deadline; forcing exit.`
        );
        exitWithFailure();
      }, EMERGENCY_REUSED_DISPOSE_DEADLINE_MS);
    }

    void this.dispose(EMERGENCY_FLUSH_TIMEOUTS).finally((): void => {
      if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
      exitWithFailure();
    });
  }

  /**
   * 等待 runner 在途更新排空，若取消后仍未结算则标记 `runnerCancellationUnsettled`。
   * @param runner 已确认更新批处理 runner。
   * @returns 在预算内自然排空返回 `true`，超时取消或未结算返回 `false`。
   */
  private async waitForRunnerDrain(
    runner: AcknowledgedUpdateRunner
  ): Promise<boolean> {
    const result: "drained" | "aborted" | "unsettled" =
      await drainAcknowledgedUpdateRunner(runner, this.dependencies);
    if (result === "unsettled") this.runnerCancellationUnsettled = true;
    return result === "drained";
  }

  /**
   * 等待启动期挂出的群标题维护任务在预算内完成。
   * @param timeoutMs 等待预算毫秒数。
   * @returns 未启动、已完成或在预算内结算返回 `true`，超时取消返回 `false`。
   */
  private async waitForBackgroundMaintenance(timeoutMs: number): Promise<boolean> {
    const task: Promise<void> | null = this.chatTitleRefreshTask;
    if (task === null || this.chatTitleRefreshSettled) return true;
    return waitForLifecycleBackgroundMaintenance(task, timeoutMs, this.dependencies);
  }

  /**
   * 持锁时执行确认最终 offset 前的全量排空与落盘。
   * @param timeouts 各阶段的排空与落盘时间预算。
   * @param deadline 整段停机的单调总截止。
   * @returns 已持锁且全部阶段干净落盘返回 `true`，未持锁或任一阶段未完成返回 `false`。
   */
  private flushAllToDisk(timeouts: FlushTimeouts, deadline: number): Promise<boolean> {
    if (!this.lockAcquired) return Promise.resolve(false);
    return flushAllToDisk({
      dependencies: this.dependencies,
      flags: this.flags,
      settler: createOwnerSettler(this.dependencies.logger),
      timeouts,
      deadline,
    });
  }
}
