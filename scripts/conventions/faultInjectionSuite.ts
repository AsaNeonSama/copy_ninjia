import { existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type ts from "typescript";
import { parseSourceFile, runtimeModuleReferences, sourceFilesUnder } from "./sourceAnalysis";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import type { ColdMigrationEdge } from "../migrations/active";
import type { RuntimeModuleReference } from "./sourceAnalysis";

/**
 * `bun run test:fault-injection` 的清单必须覆盖全部持久化 / 停机 / Worker 生命周期用例。
 *
 * 清单手工维护在本模块的 FAULT_INJECTION_TESTS，是这套套件的唯一权威；scripts/testFaultInjection.ts
 * 按它执行 `bun test --isolate`。
 *
 * 本模块按测试 harness 与生产恢复/生命周期边界的值导入给出机器可判的下界。
 * 归属按解析后的路径判定，包含动态 import 与目录入口 `index.ts`，忽略纯类型引用。
 * 兼容入口这类混合主题模块可把边界限定到具体导出：只有取用其中之一（命名空间按
 * 属性访问判定），或以无法静态确定取用范围的形态引用时，才要求登记。
 *
 * 判定只做下界，不禁止清单里出现别的文件：不依赖 harness 的故障注入用例（例如
 * readiness mock 整文件生效的那种）没有机器可判的特征，由维护者登记。
 */

/**
 * `bun run test:fault-injection` 执行的用例文件，仓库相对路径，按字典序一行一个。
 * 约定检查要求它覆盖全部使用 FAULT_INJECTION_BOUNDARIES 的用例；不依赖这些边界的故障注入用例
 * 由维护者登记。
 */
export const FAULT_INJECTION_TESTS: readonly string[] = [
  "test/aiChat/ai/imageGenerationCancellation.test.ts",
  "test/aiChat/ai/replyActionChains.test.ts",
  "test/aiChat/ai/stickers/setsReload.test.ts",
  "test/aiChat/ai/weather.test.ts",
  "test/aiChat/voiceSynthesis.test.ts",
  "test/aiChat/webDigest.test.ts",
  "test/antiRaid/durableDeliveryFailure.test.ts",
  "test/antiRaid/durableDrainBudget.test.ts",
  "test/antiRaid/lockdownMirrorIteration.test.ts",
  "test/antiRaid/verificationMirror.test.ts",
  "test/antiRaid/workerBridgeController.test.ts",
  "test/antiRaid/workerBridgeObservers.test.ts",
  "test/antiRaid/workerBridgeReplay.test.ts",
  "test/app/configReload.test.ts",
  "test/app/lifecycle.test.ts",
  "test/app/lifecycleFailure.test.ts",
  "test/app/lifecycleImageInput.test.ts",
  "test/app/lifecycleOffsetShutdown.test.ts",
  "test/app/lifecycleOptionalConfig.test.ts",
  "test/app/lifecycleStateInput.test.ts",
  "test/app/updateFetcher.test.ts",
  "test/app/updateRunner.test.ts",
  "test/app/updateRunnerResources.test.ts",
  "test/auto/reactionSync.test.ts",
  "test/commands/blocklistFanOut.test.ts",
  "test/commands/copyShared.test.ts",
  "test/commands/copyTeardown.test.ts",
  "test/commands/deferredCommands.test.ts",
  "test/commands/deleteMessage.test.ts",
  "test/commands/gag.ingress.test.ts",
  "test/commands/gag.lifecycle.test.ts",
  "test/commands/gag.refresh.test.ts",
  "test/commands/gag.speech.test.ts",
  "test/commands/hImage.test.ts",
  "test/commands/hImageAdd.test.ts",
  "test/commands/luckChallenge.test.ts",
  "test/commands/qa.test.ts",
  "test/commands/translate.test.ts",
  "test/commands/wed.test.ts",
  "test/commands/wedDispatch.test.ts",
  "test/commands/wedMemberReview.test.ts",
  "test/commands/wedMembers.test.ts",
  "test/commands/wedPersistence.test.ts",
  "test/commands/wedRuntime.test.ts",
  "test/config/googleAuth.test.ts",
  "test/config/readiness.test.ts",
  "test/cron/delivery.test.ts",
  "test/cron/run.test.ts",
  "test/cron/scheduler.test.ts",
  "test/database/chatQaCodec.test.ts",
  "test/database/storageAdmin.test.ts",
  "test/database/storageConnection.test.ts",
  "test/database/storageMigration.test.ts",
  "test/database/storageReader.test.ts",
  "test/database/storageRows.test.ts",
  "test/database/storageRowsValidation.test.ts",
  "test/database/storageTransaction.test.ts",
  "test/infra/aiCacheUsagePipeline.test.ts",
  "test/infra/blocklistOutbox.test.ts",
  "test/infra/blocklistParticipantInvalid.test.ts",
  "test/infra/blocklistParticipantInvalidOrdering.test.ts",
  "test/infra/blocklistSweep.test.ts",
  "test/infra/blocklistSweepReadFailure.test.ts",
  "test/infra/blocklistSweepTriggers.test.ts",
  "test/infra/blocklistUnblock.test.ts",
  "test/infra/chatStateStorage.test.ts",
  "test/infra/chatTeardown.test.ts",
  "test/infra/chatTitle.test.ts",
  "test/infra/diskIOBackpressure.test.ts",
  "test/infra/diskIODiagnosticRestart.test.ts",
  "test/infra/diskIOGiveUp.test.ts",
  "test/infra/diskIOInitialization.test.ts",
  "test/infra/diskIORecoveryTransport.test.ts",
  "test/infra/diskIORequestChannels.test.ts",
  "test/infra/diskIOStorageClose.test.ts",
  "test/infra/geminiContextCache.test.ts",
  "test/infra/httpFetch.test.ts",
  "test/infra/identityStorageCache.test.ts",
  "test/infra/identityStorageSweep.test.ts",
  "test/infra/identityStorageTemporaryAdBypass.test.ts",
  "test/infra/joinLog.test.ts",
  "test/infra/loggerForwarding.test.ts",
  "test/infra/qaStore.test.ts",
  "test/infra/randomImage.test.ts",
  "test/infra/stickerReceipt.test.ts",
  "test/infra/storage/cleanup.test.ts",
  "test/infra/storage/dataRoot.test.ts",
  "test/infra/storage/stateStore.test.ts",
  "test/infra/storage/stateStoreCopy.test.ts",
  "test/infra/storage/stateStoreFacade.test.ts",
  "test/infra/storage/stateStoreTtsUsage.test.ts",
  "test/infra/storageLock.test.ts",
  "test/infra/storageLockDurability.test.ts",
  "test/infra/telegramActions.errors.test.ts",
  "test/infra/telegramOutboundGate.test.ts",
  "test/infra/telegramOutboundGateLateResponse.test.ts",
  "test/infra/telegramOutboundIntegration.test.ts",
  "test/infra/telegramOutboundTimeout.test.ts",
  "test/infra/telegramSendScheduler.test.ts",
  "test/infra/telegramSendSchedulerInvariants.test.ts",
  "test/infra/telegramSignal.test.ts",
  "test/infra/telegramWorkerCapabilities.test.ts",
  "test/libs/acknowledgedBatchQueue.test.ts",
  "test/libs/atomicFile.test.ts",
  "test/libs/diskIORecoveryRevisions.test.ts",
  "test/libs/drainWaiter.test.ts",
  "test/libs/fileAccess.test.ts",
  "test/libs/flushBarrier.test.ts",
  "test/libs/latestValueRunner.test.ts",
  "test/libs/monotonicDeadline.test.ts",
  "test/libs/sleep.test.ts",
  "test/libs/supervisedWorker.test.ts",
  "test/libs/workerDuplex.test.ts",
  "test/scripts/installMigration.test.ts",
  "test/scripts/installStartup.test.ts",
  "test/scripts/migrateWedMemberWindow.test.ts",
  "test/states/lockdown.test.ts",
  "test/states/lockdownMatrix.test.ts",
  "test/translate/client.test.ts",
  "test/translate/message.test.ts",
  "test/translate/state.test.ts",
  "test/workers/aiChat/compaction.test.ts",
  "test/workers/aiChat/mainMirrorRecovery.test.ts",
  "test/workers/aiChat/mainMirrorUnconfigured.test.ts",
  "test/workers/aiChat/replyDelivery.test.ts",
  "test/workers/aiChat/replyDeliveryPressure.test.ts",
  "test/workers/aiChat/replyOrder.test.ts",
  "test/workers/aiChat/replyPipeline.test.ts",
  "test/workers/aiChat/replyRound.test.ts",
  "test/workers/aiChat/replyState.test.ts",
  "test/workers/aiChat/stickerMirror.test.ts",
  "test/workers/aiChat/voiceSynthesis.test.ts",
  "test/workers/aiChat/webDigest.test.ts",
  "test/workers/aiChat/workerLifecycle.test.ts",
  "test/workers/antiRaid/adDetectAiGoogle.test.ts",
  "test/workers/antiRaid/blocklistEffects.test.ts",
  "test/workers/antiRaid/blocklistEffectsParticipantInvalid.test.ts",
  "test/workers/antiRaid/cacheOwners.test.ts",
  "test/workers/antiRaid/floodControl.test.ts",
  "test/workers/antiRaid/linkedChannelCancellation.test.ts",
  "test/workers/antiRaid/linkedChannelVerification.test.ts",
  "test/workers/antiRaid/lockdownJoinWindow.test.ts",
  "test/workers/antiRaid/lockdownOwnership.test.ts",
  "test/workers/antiRaid/lockdownPersistence.test.ts",
  "test/workers/antiRaid/lockdownReapply.test.ts",
  "test/workers/antiRaid/lockdownTimers.test.ts",
  "test/workers/antiRaid/mainMirrorPersistence.test.ts",
  "test/workers/antiRaid/mainMirrorRecovery.test.ts",
  "test/workers/antiRaid/taskTracker.test.ts",
  "test/workers/antiRaid/verificationAttemptBudget.test.ts",
  "test/workers/antiRaid/verificationCallback.test.ts",
  "test/workers/antiRaid/verificationCapacity.test.ts",
  "test/workers/antiRaid/verificationFlood.test.ts",
  "test/workers/antiRaid/verificationRecovery.test.ts",
  "test/workers/antiRaid/verificationWelcome.test.ts",
  "test/workers/antiRaid/workerLifecycle.test.ts",
  "test/workers/byteTransfer.test.ts",
  "test/workers/diskIO/adSampleFile.test.ts",
  "test/workers/diskIO/aiCacheFile.test.ts",
  "test/workers/diskIO/aiContextStorage.test.ts",
  "test/workers/diskIO/appendOnlyDayFile.test.ts",
  "test/workers/diskIO/blocklistIdPage.test.ts",
  "test/workers/diskIO/blocklistRemovalOutbox.test.ts",
  "test/workers/diskIO/chatQaWrite.test.ts",
  "test/workers/diskIO/joinLogCompaction.test.ts",
  "test/workers/diskIO/joinLogFiles.test.ts",
  "test/workers/diskIO/joinLogUserCapacity.test.ts",
  "test/workers/diskIO/logFiles.test.ts",
  "test/workers/diskIO/luckFiles.test.ts",
  "test/workers/diskIO/luckSecretFile.test.ts",
  "test/workers/diskIO/maintenanceCron.test.ts",
  "test/workers/diskIO/midnightMaintenance.test.ts",
  "test/workers/diskIO/operationQueue.test.ts",
  "test/workers/diskIO/recoveryInputTopology.test.ts",
  "test/workers/diskIO/snapshotFiles.stickerCatalog.test.ts",
  "test/workers/diskIO/snapshotOwners.test.ts",
  "test/workers/diskIO/stickerReceipts.test.ts",
  "test/workers/diskIO/storageBackpressure.test.ts",
  "test/workers/diskIO/storageDatabaseFlush.test.ts",
  "test/workers/diskIO/storageDatabaseSchemaGate.test.ts",
  "test/workers/diskIO/storageDatabaseShutdown.test.ts",
  "test/workers/diskIO/storageRevisionValidation.test.ts",
  "test/workers/diskIO/temporaryAdBypass.test.ts",
  "test/workers/diskIO/timedFlush.test.ts",
  "test/workers/diskIO/verificationFiles.test.ts",
  "test/workers/diskIO/verificationWriteTimers.test.ts",
  "test/workers/diskIO/wedMemberFiles.test.ts",
  "test/workers/diskIOWorker.test.ts",
  "test/workers/diskIOWorkerDispatch.test.ts",
  "test/workers/diskIOWorkerShutdown.test.ts",
  "test/workers/diskIOWorkerThread.test.ts",
];

/** 受约束的持久化校验、恢复和生命周期边界，包含生产模块及测试 harness。 */
interface FaultInjectionBoundary {
  /** 仓库相对路径；缺失即判失败。 */
  readonly path: string;
  /** 该边界覆盖的故障面，用于失败文案。 */
  readonly purpose: string;
  /** 只有取用这些导出才计入；缺省表示对该模块的任何运行期引用都计入。 */
  readonly exports?: readonly string[];
}

/**
 * 判定所依据的持久化校验、恢复和生命周期边界清单。
 *
 * 只收主题是持久化、停机或 Worker 生命周期的模块。`verificationEffectsHarness`
 * （验证副作用解释器，主题是踢人与删消息）和 `adDetectQueueHarness`（广告判定队列
 * 随 isolate 生死、主线程不做镜像，见 `packages/cache/workers/antiRaid/adDetect.ts`
 * 的模块头注）不落盘，不在清单内。
 */
export const FAULT_INJECTION_BOUNDARIES: readonly FaultInjectionBoundary[] = [
  ...ACTIVE_COLD_MIGRATION_EDGES.map((edge: ColdMigrationEdge): FaultInjectionBoundary => ({
    path: edge.entryPath,
    purpose: `${edge.command} cold migration integrity and interruption recovery`,
  })),
  {
    path: "test/helpers/diskIOWorkerHarness.ts",
    purpose: "Disk I/O Worker initialization, backpressure, diagnostic restart and give-up",
  },
  {
    path: "test/helpers/antiRaidMirrorHarness.ts",
    purpose: "Anti-Raid main-thread mirror durability barriers and rebuild recovery",
  },
  {
    path: "test/helpers/blocklistSweepHarness.ts",
    purpose: "blocklist sweep and removal-outbox startup recovery and write-off",
  },
  {
    path: "test/helpers/lifecycleFixture.ts",
    purpose: "application startup and shutdown lifecycle failure injection",
  },
  { path: "test/helpers/storageDatabaseHydration.ts", purpose: "SQLite storage hydration and Disk I/O write handlers" },
  {
    path: "packages/infra/storage/stateStore.ts",
    purpose: "global state persistence facade, fatal handler and flush",
    exports: ["StateStore", "loadState", "persistGlobalState", "setStatePersistenceFatalHandler", "flushStateToDisk"],
  },
  { path: "packages/infra/storage/statePersistence.ts", purpose: "global state atomic writes, retry budget and fatal stop" },
  { path: "packages/libs/latestValueRunner.ts", purpose: "latest-only persistence writer failure and settlement" },
  { path: "packages/libs/acknowledgedBatchQueue.ts", purpose: "Disk I/O and log forwarding acknowledgement and redelivery" },
  { path: "packages/infra/logger/forwarding.ts", purpose: "Worker log forwarding acknowledgement and drop summary" },
  { path: "packages/libs/monotonicDeadline.ts", purpose: "shutdown and retry budget deadlines" },
  { path: "packages/database/interact/connection.ts", purpose: "SQLite connection open, close and WAL enablement" },
  {
    path: "packages/workers/diskIO/storageDatabase/identityPolicy.ts",
    purpose: "identity policy SQLite writes and paged startup reads",
  },
  { path: "packages/workers/diskIO/luckSecretFile.ts", purpose: "luck secret atomic publication and recovery" },
  { path: "packages/workers/diskIO/snapshotFiles.ts", purpose: "snapshot inspect, adoption and recovery maintenance" },
  { path: "packages/database/validation/storageRows.ts", purpose: "strict SQLite startup row validation" },
  {
    path: "packages/workers/diskIO/storageDatabase/shutdown.ts",
    purpose: "clean-shutdown residual commit, WAL checkpoint and storage database close",
  },
  { path: "packages/workers/aiChat/replyPipeline.ts", purpose: "reply admission, draining and cancellation" },
  { path: "packages/workers/aiChat/replyRound.ts", purpose: "reply model, action and resource lifecycle" },
  { path: "packages/workers/aiChat/replyDelivery.ts", purpose: "reply delivery capacity and generation cleanup" },
  { path: "packages/workers/aiChat/webDigest.ts", purpose: "web digest composition draining, cancellation and settlement" },
  { path: "packages/workers/antiRaid/lockdownRuntime.ts", purpose: "lockdown durable acknowledgements, restore and teardown" },
  { path: "packages/workers/antiRaid/lockdownApi.ts", purpose: "lockdown API ownership and permission compensation" },
  { path: "packages/states/lockdown.ts", purpose: "lockdown recovery and durable state transitions" },
  { path: "packages/aiChat/ai/weather.ts", purpose: "weather refresh cancellation and late-result ownership" },
  { path: "packages/infra/telegram/outboundLifecycle.ts", purpose: "Telegram outbound drain, quiesce and timeout abort" },
  {
    path: "packages/infra/telegram/actions/messageLifecycle.ts",
    purpose: "delayed message deletion shutdown flush and drain",
    exports: ["drainPendingMessageDeletions", "flushPendingMessageDeletions"],
  },
  {
    path: "packages/infra/telegram/actions.ts",
    purpose: "delayed message deletion shutdown flush and drain",
    exports: ["drainPendingMessageDeletions", "flushPendingMessageDeletions"],
  },
  {
    path: "packages/infra/telegram/index.ts",
    purpose: "delayed message deletion shutdown drain",
    exports: ["drainPendingMessageDeletions"],
  },
  { path: "packages/libs/drainWaiter.ts", purpose: "drain waiter settlement and timeout" },
  { path: "packages/infra/supervisedDuplexWorker.ts", purpose: "duplex Worker rebuild cancellation and generation-scoped replies" },
  { path: "packages/infra/chatTeardown.ts", purpose: "combined chat teardown ordering and failure propagation" },
  { path: "packages/infra/joinLog.ts", purpose: "join-log durable barrier and teardown purge" },
  { path: "packages/workers/antiRaid/taskTracker.ts", purpose: "Anti-Raid task draining, dispatch quiesce and generation isolation" },
  {
    path: "packages/workers/antiRaid/verificationRuntime.ts",
    purpose: "verification adoption, persisted terminal resume and generation isolation",
  },
  { path: "packages/infra/storage/instanceLock.ts", purpose: "single-instance lock acquisition, stale-owner recovery and release" },
  { path: "packages/app/lifecycle/shutdown.ts", purpose: "application shutdown ordering, drain budgets and final flush" },
  { path: "packages/antiRaid/durableDelivery.ts", purpose: "Anti-Raid durable delivery barriers and shutdown drain budget" },
  { path: "packages/antiRaid/workerBridge/controller.ts", purpose: "Anti-Raid Worker initialization and rebuild replay" },
];

/** 该引用是否触及边界：未限定导出的边界按整模块计，无法确定取用范围的引用同样计入。 */
function usesBoundary(reference: RuntimeModuleReference, boundary: FaultInjectionBoundary): boolean {
  if (boundary.exports === undefined || reference.names === null) return true;
  return reference.names.some((name: string): boolean => boundary.exports?.includes(name) === true);
}

/**
 * 相对说明符解析成绝对 `.ts` 路径，供与 harness 的真实路径比对：优先 `<说明符>.ts`，
 * 不存在时取目录入口 `<说明符>/index.ts`。
 *
 * 按路径比对，同名不同目录的模块不计入。裸说明符（`bun:test`、`grammy/types`）
 * 返回 undefined，直接跳过。
 */
function resolvedSpecifierPath(importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved: string = resolve(dirname(importerPath), specifier);
  if (extname(resolved) === ".ts") return resolved;
  const file: string = `${resolved}.ts`;
  const directoryEntry: string = join(resolved, "index.ts");
  return !existsSync(file) && existsSync(directoryEntry) ? directoryEntry : file;
}

/** 核对清单里的每条路径都真实存在且只出现一次。 */
function collectListedPathProblems(
  projectRoot: string,
  listed: readonly string[]
): readonly string[] {
  const problems: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const path of listed) {
    if (seen.has(path)) problems.push(`test:fault-injection lists ${path} more than once`);
    seen.add(path);
    if (!existsSync(join(projectRoot, path))) {
      problems.push(`test:fault-injection lists a file that does not exist: ${path}`);
    }
  }
  return problems;
}

/**
 * 核对 `test:fault-injection` 的清单：列出的路径都存在且不重复，且每个使用受约束
 * 恢复和生命周期边界的用例文件都已登记。listed 缺省为 FAULT_INJECTION_TESTS。
 */
export async function collectFaultInjectionSuiteProblems(
  projectRoot: string,
  listed: readonly string[] = FAULT_INJECTION_TESTS
): Promise<readonly string[]> {
  const problems: string[] = [...collectListedPathProblems(projectRoot, listed)];
  const listedSet: ReadonlySet<string> = new Set<string>(listed);
  const requiredModules: Map<string, FaultInjectionBoundary> = new Map();
  for (const harness of FAULT_INJECTION_BOUNDARIES) {
    const harnessPath: string = join(projectRoot, harness.path);
    if (!(await Bun.file(harnessPath).exists())) {
      problems.push(`declared fault-injection boundary does not exist: ${harness.path}`);
      continue;
    }
    requiredModules.set(harnessPath, harness);
  }
  const testRoot: string = join(projectRoot, "test");
  if (!existsSync(testRoot)) {
    problems.push("test directory does not exist; the fault-injection suite cannot be verified");
    return problems;
  }
  for (const path of sourceFilesUnder(testRoot)) {
    if (!path.endsWith(".test.ts")) continue;
    const relativePath: string = relative(projectRoot, path);
    if (listedSet.has(relativePath)) continue;
    const source: ts.SourceFile = await parseSourceFile(path);
    for (const reference of runtimeModuleReferences(source)) {
      const resolved: string | undefined = resolvedSpecifierPath(path, reference.specifier);
      if (resolved === undefined) continue;
      const harness: FaultInjectionBoundary | undefined = requiredModules.get(resolved);
      if (harness === undefined || !usesBoundary(reference, harness)) continue;
      problems.push(
        `${relativePath} uses ${harness.path} (${harness.purpose}) ` +
        "but is missing from FAULT_INJECTION_TESTS"
      );
      break;
    }
  }
  return problems;
}
