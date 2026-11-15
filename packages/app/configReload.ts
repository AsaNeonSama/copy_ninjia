/**
 * `config/dynamic/` 动态部署配置热重载的主线程协调器（运行状态见 `cache/main/configReload.ts`）。
 *
 * - 监听边界：仅监听 `config/dynamic/`（`config/static/` 与配置根变更需重启生效）。
 *   目录级 `fs.watch` 覆盖原地写入、临时文件原子替换、删除与重建；目录自身被改名替换时关闭旧 watcher
 *   并重新挂载，目录暂缺期间按退避表重试且仅首次记录错误日志。
 * - 串行对账：任意文件系统事件重置防抖定时器，到期后经 `createLatestValueRunner` 串行执行一轮
 *   读取与校验（见 `config/reload.ts`）：先核对目录白名单，再解析变更文件、更新主线程配置快照、
 *   重算广告检测与 AI 闲聊就绪状态，并将变更分发至对应 Worker 或定时任务调度器。在途期间的新事件
 *   合并为至多一轮补跑；校验被拒时记录英文错误日志并保留上一份合法快照。
 * - 可用性切换：功能转为不可用时立即发布结论；AI 闲聊转为可用时先调用 `resumeAiChat` 恢复 Worker，
 *   成功后才对外发布可用结论。
 * - 停机收口：watcher 与定时器均调用 `unref()`；停机维护关闸调用 `quiesceConfigReload` 停止接纳，
 *   已在途的读盘完成后直接丢弃，不再应用或分发。
 * @see ../../docs/cn/04-invariants.md
 */

import { watch } from "node:fs";
import type { FSWatcher, WatchEventType } from "node:fs";
import { basename } from "node:path";
import { resumeAiChat, syncAiChatConfig } from "../aiChat";
import { syncAntiRaidAgentConfig } from "../antiRaid";
import { reconcileCronSchedule } from "../cron/scheduler";
import { configReloadRuntime } from "../cache/main/configReload";
import {
  adDetectConfigReadiness,
  adDetectReadinessFromHolders,
  adoptAdDetectConfigReadiness,
  adoptAiChatConfigReadiness,
  aiChatConfigReadiness,
  aiChatReadinessFromHolders,
} from "../config/readiness";
import { applyHotDeploymentConfigs, readHotDeploymentConfigs } from "../config/reload";
import { CONFIG_RELOAD_DEBOUNCE_MS, CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS } from "../consts/configReload";
import { DYNAMIC_CONFIG_DIR } from "../consts/paths";
import { logger } from "../infra/logger";
import { createLatestValueRunner } from "../libs/latestValueRunner";
import type { ConfigReadiness, HotDeploymentConfigChanges, HotDeploymentConfigReads } from "../types/config";

/**
 * 判定两份配置就绪结论是否等价（可用性一致，且不可用时首个失败文件相同）。
 * @param next 最新计算的可用性结论。
 * @param current 当前已发布的可用性结论。
 * @returns 两份结论等价时返回 `true`，否则返回 `false`。
 */
function sameReadiness(next: ConfigReadiness, current: ConfigReadiness): boolean {
  if (next.ok || current.ok) return next.ok === current.ok;
  return next.failure.file === current.failure.file;
}

/**
 * 根据主线程配置快照重算广告检测就绪状态；状态或相关配置变更时同步至 Anti-Raid Worker。
 * @param changes 本轮热重载应用后的配置变更摘要。
 */
function reconcileAdDetectAvailability(changes: HotDeploymentConfigChanges): void {
  const next: ConfigReadiness = adDetectReadinessFromHolders();
  const current: ConfigReadiness = adDetectConfigReadiness();
  const availabilityChanged: boolean = next.ok !== current.ok;
  // 先更新就绪结论，供下方 syncAntiRaidAgentConfig 决定是否投递 ad_detect.json 快照。
  if (!sameReadiness(next, current)) adoptAdDetectConfigReadiness(next);
  if (availabilityChanged) {
    if (next.ok) logger.log("Ad detection became available after a deployment config reload.");
    else logger.log(`Ad detection became unavailable after a deployment config reload: ${next.failure.reason}`);
  }
  if (availabilityChanged || changes.adDetect || changes.adDetectConfig) syncAntiRaidAgentConfig();
}

/**
 * 根据主线程配置快照重算 AI 闲聊就绪状态；由不可用转为可用时先恢复 Worker 再发布结论，已可用时按变更项同步配置。
 * @param changes 本轮热重载应用后的配置变更摘要。
 */
function reconcileAiChatAvailability(changes: HotDeploymentConfigChanges): void {
  const next: ConfigReadiness = aiChatReadinessFromHolders();
  const current: ConfigReadiness = aiChatConfigReadiness();
  if (!next.ok) {
    if (current.ok) {
      logger.log(`AI chat became unavailable after a deployment config reload; the AI Worker stays idle: ${next.failure.reason}`);
    }
    if (!sameReadiness(next, current)) adoptAiChatConfigReadiness(next);
    return;
  }
  if (!current.ok) {
    try {
      resumeAiChat();
    } catch (error: unknown) {
      logger.error("AI chat could not resume after a deployment config reload; it stays unavailable until the next config change:", error);
      return;
    }
    adoptAiChatConfigReadiness(next);
    logger.log("AI chat became available after a deployment config reload.");
    return;
  }
  if (changes.aiAgent || changes.mood || changes.stickers) syncAiChatConfig(changes);
}

/** 执行单轮动态配置读取、快照更新与下游分发；停机关闸后丢弃在途读盘结果。 */
async function reconcileDeploymentConfigs(): Promise<void> {
  const reads: HotDeploymentConfigReads = await readHotDeploymentConfigs();
  if (!configReloadRuntime.accepting) return;
  const changes: HotDeploymentConfigChanges = applyHotDeploymentConfigs(reads);
  for (const rejection of changes.rejections) {
    logger.error(`Rejected a runtime deployment config change; keeping the last validated snapshot: ${rejection}`);
  }
  for (const path of changes.reloadedPaths) {
    logger.log(`Reloaded deployment config ${path}.`);
  }
  for (const path of changes.removedPaths) {
    logger.log(`Deployment config ${path} was removed.`);
  }
  reconcileAdDetectAvailability(changes);
  reconcileAiChatAvailability(changes);
  if (changes.cron) reconcileCronSchedule();
}

/** 防抖定时器到期回调：触发串行执行器对账一轮；异常仅记错误日志，留待后续文件事件重试。 */
function runConfigReload(): void {
  configReloadRuntime.debounceTimer = null;
  const runner: typeof configReloadRuntime.runner = configReloadRuntime.runner;
  if (!configReloadRuntime.accepting || runner === null) return;
  runner.push(null).catch((error: unknown): void => {
    logger.error("Deployment config reload failed:", error);
  });
}

/** 重置动态配置热重载的防抖定时器。 */
function scheduleConfigReload(): void {
  if (!configReloadRuntime.accepting) return;
  if (configReloadRuntime.debounceTimer !== null) clearTimeout(configReloadRuntime.debounceTimer);
  const timer: ReturnType<typeof setTimeout> = setTimeout(runConfigReload, CONFIG_RELOAD_DEBOUNCE_MS);
  timer.unref();
  configReloadRuntime.debounceTimer = timer;
}

/**
 * 处理 `config/dynamic/` 目录事件；若被监听目录自身发生重命名，额外安排重建目录监听。
 * @param event 文件系统事件类型。
 * @param filename 触发事件的文件或目录名（未知时为 `null`）。
 */
function handleConfigDirectoryEvent(event: WatchEventType, filename: string | null): void {
  if (event === "rename" && filename === basename(DYNAMIC_CONFIG_DIR)) {
    scheduleConfigRewatch(CONFIG_RELOAD_DEBOUNCE_MS);
  }
  scheduleConfigReload();
}

/**
 * 调度一次目录监听重建；已有待执行的重建定时器时不重复调度。
 * @param delayMs 触发重建监听前的等待毫秒数。
 */
function scheduleConfigRewatch(delayMs: number): void {
  if (!configReloadRuntime.accepting || configReloadRuntime.rewatchTimer !== null) return;
  const timer: ReturnType<typeof setTimeout> = setTimeout(rewatchConfigDirectory, delayMs);
  timer.unref();
  configReloadRuntime.rewatchTimer = timer;
}

/**
 * 关闭旧 watcher 并重新监听 `config/dynamic/`：成功后立即对账一轮；目录暂缺时按退避表重试，仅首次失败记录错误日志。
 */
function rewatchConfigDirectory(): void {
  configReloadRuntime.rewatchTimer = null;
  if (!configReloadRuntime.accepting) return;
  configReloadRuntime.watcher?.close();
  configReloadRuntime.watcher = null;
  let watcher: FSWatcher;
  try {
    watcher = watch(DYNAMIC_CONFIG_DIR, handleConfigDirectoryEvent);
  } catch (error: unknown) {
    const attempt: number = configReloadRuntime.rewatchAttempts;
    if (attempt === 0) {
      logger.error("Deployment config directory is unavailable after it was replaced; retrying the watcher with backoff:", error);
    }
    const lastIndex: number = CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS.length - 1;
    if (attempt < lastIndex) configReloadRuntime.rewatchAttempts = attempt + 1;
    scheduleConfigRewatch(CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS[Math.min(attempt, lastIndex)]!);
    return;
  }
  configReloadRuntime.rewatchAttempts = 0;
  installConfigWatcher(watcher);
  logger.log(`Re-attached the deployment config watcher to ${DYNAMIC_CONFIG_DIR}.`);
  runConfigReload();
}

/**
 * 处理 watcher 底层错误并关闭监听；当前进程余下生命周期停用热重载，待重启恢复。
 * @param error watcher 抛出的错误对象。
 */
function handleWatcherError(error: unknown): void {
  logger.error("Deployment config watcher failed; runtime config reload stays off until restart:", error);
  clearConfigRewatch();
  configReloadRuntime.watcher?.close();
  configReloadRuntime.watcher = null;
}

/** 取消待执行的重建监听定时器并清零连续失败计数。 */
function clearConfigRewatch(): void {
  if (configReloadRuntime.rewatchTimer !== null) {
    clearTimeout(configReloadRuntime.rewatchTimer);
    configReloadRuntime.rewatchTimer = null;
  }
  configReloadRuntime.rewatchAttempts = 0;
}

/**
 * 为新创建的目录 watcher 绑定错误处理、调用 `unref()` 并写入运行时句柄。
 * @param watcher 新建立的目录监视器实例。
 */
function installConfigWatcher(watcher: FSWatcher): void {
  watcher.on("error", handleWatcherError);
  watcher.unref();
  configReloadRuntime.watcher = watcher;
}

/**
 * 启动 `config/dynamic/` 热重载监听（幂等）。
 * 必须在 AI 闲聊与 Anti-Raid 初始化完成后调用，并在挂载成功后立即对账一轮以覆盖启动窗口内的文件改动；
 * 挂载失败时仅记错误日志，已加载配置继续生效。
 */
export function startConfigReload(): void {
  if (configReloadRuntime.watcher !== null) return;
  let watcher: FSWatcher;
  try {
    watcher = watch(DYNAMIC_CONFIG_DIR, handleConfigDirectoryEvent);
  } catch (error: unknown) {
    logger.error("Deployment config watcher could not start; runtime config reload stays off until restart:", error);
    return;
  }
  configReloadRuntime.runner ??= createLatestValueRunner<null>(reconcileDeploymentConfigs);
  configReloadRuntime.accepting = true;
  installConfigWatcher(watcher);
  runConfigReload();
}

/** 停机维护关闸：停止接纳事件、清除防抖与重建监听 timer 并关闭 watcher；可重复调用。 */
export function quiesceConfigReload(): void {
  configReloadRuntime.accepting = false;
  if (configReloadRuntime.debounceTimer !== null) {
    clearTimeout(configReloadRuntime.debounceTimer);
    configReloadRuntime.debounceTimer = null;
  }
  clearConfigRewatch();
  configReloadRuntime.watcher?.close();
  configReloadRuntime.watcher = null;
}
