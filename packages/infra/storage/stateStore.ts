/**
 * 主线程全局状态门面：维护全局复读（`globalCopyState`）与每日 TTS 用量（`globalTtsUsageState`）
 * 的内存镜像，并封装 `StateStore` 持久化与停机排空边界。群级状态读写与持久化见 `infra/chatStateStorage.ts`。
 */

import type { FlushResult } from "../../types/lifecycle";
import { globalCopyState, globalTtsUsageState, stateStoreHolder } from "../../cache/main/storage";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type {
  CachedUser,
  CopyMode,
  DecodedGlobalCopyState,
  DecodedGlobalState,
  GlobalCopyState,
  GlobalState,
} from "../../types/chatState";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { StateStore, loadCurrentGlobalState } from "./statePersistence";
import { toError } from "../../libs/errorMessage";

export { StateStore } from "./statePersistence";

/**
 * 获取或懒初始化进程级共享 `StateStore` 单例。
 *
 * @returns 主线程共享的全局状态持久化存储实例。
 */
function sharedStateStore(): StateStore {
  stateStoreHolder.current ??= new StateStore();
  return stateStoreHolder.current;
}

/**
 * 全局复读状态的只读视图；写入只经 adoptCopyTarget/clearCopyTarget 与复读冷却的两个函数。
 *
 * @returns 当前全局复读状态的只读引用。
 */
export function getGlobalCopyState(): Readonly<GlobalCopyState> {
  return globalCopyState;
}

/**
 * 本群此刻的复读目标 id；没有目标、或目标锁在别的群时为 undefined。
 *
 * 用于每条群消息与每次反应更新，只返回目标 id，不创建投影对象。
 * 需要整份身份的冷路径直接读 getGlobalCopyState()。
 *
 * @param chatId 群聊 ID。
 * @returns 该群当前生效的复读目标用户 ID；未命中时返回 `undefined`。
 */
export function activeCopyTargetIdIn(chatId: number): number | undefined {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) {
    return undefined;
  }
  return globalCopyState.copiedUser.id;
}

/**
 * 本群此刻生效的复读模式。调用方先用 activeCopyTargetIdIn 确认本群确有目标；
 * 此时 undefined 表示该目标没有指定模式。
 *
 * @param chatId 群聊 ID。
 * @returns 该群当前生效的复读模式；未指定或无目标时返回 `undefined`。
 */
export function activeCopyModeIn(chatId: number): CopyMode | undefined {
  if (globalCopyState.copiedUser === null || globalCopyState.copyChatId !== chatId) {
    return undefined;
  }
  return globalCopyState.copyMode;
}

/**
 * 锁定复读目标：三元组整体写，不留「有目标但还没记群」的中间态。启动恢复与
 * `/copy` 系命令共用这一个写入边界（见 cache/main/storage.ts 的 globalCopyState）。
 * 目标身份按 Telegram 给出的原样保存，空字符串名称同样保留。
 *
 * @param copiedUser 被复读的目标用户身份快照。
 * @param copyMode 复读模式（未指定时为 `undefined`）。
 * @param copyChatId 复读生效的群聊 ID。
 */
export function adoptCopyTarget(copiedUser: CachedUser, copyMode: CopyMode | undefined, copyChatId: number): void {
  globalCopyState.copiedUser = copiedUser;
  globalCopyState.copyMode = copyMode;
  globalCopyState.copyChatId = copyChatId;
}

/**
 * 解除复读目标：与 adoptCopyTarget 对称，三元组整体清空。lastCopyTime 是冷却
 * 记账，不属于这一组，解除时保持原值。
 */
export function clearCopyTarget(): void {
  globalCopyState.copiedUser = null;
  globalCopyState.copyMode = undefined;
  globalCopyState.copyChatId = undefined;
}

/**
 * 占住全局复读冷却：同步写入新的冷却起点并返回原值，调用方放弃这次尝试时把两者
 * 交给 restoreCopyCooldown。只改内存，落盘由调用方经 persistGlobalState 完成（见
 * commands/copyShared.ts 的 claimCopyCooldownOrReject）。
 *
 * @param claimedAt 本次占用的毫秒时间戳。
 * @returns 占用前的上一次复读时间戳。
 */
export function claimCopyCooldown(claimedAt: number): number | undefined {
  const previousLastCopyTime: number | undefined = globalCopyState.lastCopyTime;
  globalCopyState.lastCopyTime = claimedAt;
  return previousLastCopyTime;
}

/**
 * 回滚一次冷却占用：只在冷却起点仍是这次占用写入的值时恢复原值。
 *
 * @param claimedAt 需要回滚的占用时间戳。
 * @param previousLastCopyTime 占用前保存的原时间戳。
 * @returns 是否发生回滚；调用方据此决定是否落盘。
 */
export function restoreCopyCooldown(claimedAt: number, previousLastCopyTime: number | undefined): boolean {
  if (globalCopyState.lastCopyTime !== claimedAt) return false;
  globalCopyState.lastCopyTime = previousLastCopyTime;
  return true;
}

/** 启动恢复：经 loadCurrentGlobalState 拒绝未迁移的状态文件，再从 memory/global/state.json 恢复主线程全局状态。 */
export async function loadState(): Promise<void> {
  try {
    const decoded: DecodedGlobalState | null = await loadCurrentGlobalState(sharedStateStore());
    if (decoded === null) return;
    if (decoded.copy.lastCopyTime !== undefined) {
      globalCopyState.lastCopyTime = decoded.copy.lastCopyTime;
    }
    // 判别联合让 copyChatId 在这一支里就是 number（配对由 libs/stateFileCodec.ts 的 globalCopy 强制）。
    const copy: DecodedGlobalCopyState = decoded.copy;
    if (copy.copiedUser !== null) {
      adoptCopyTarget(copy.copiedUser, copy.copyMode, copy.copyChatId);
    }
    globalTtsUsageState.current = decoded.ttsUsage ?? null;
  } catch (error: unknown) {
    logger.error("Failed to load state:", error);
    throw error;
  }
}

/**
 * 组装当前内存中的全局状态快照对象。
 *
 * @returns 供序列化写盘的全局状态对象。
 */
function currentGlobalState(): GlobalState {
  return {
    copy: globalCopyState,
    ttsUsage: globalTtsUsageState.current ?? undefined,
  };
}

/**
 * 语音合成每日计数的最新持久化值；null 表示从没用过。供 AI Worker 启动与重建时灌回。
 *
 * @returns 当前每日 TTS 用量快照；无记录时返回 `null`。
 */
export function getTtsUsage(): TtsDailyUsage | null {
  return globalTtsUsageState.current;
}

/**
 * 接管 AI Worker 回传的全量计数（`ttsUsage` 事件）并交给后台合并写；
 * `null`（当日计数为空）写出时不带 `ttsUsage` 键。
 *
 * @param usage 最新每日 TTS 用量快照或 `null`。
 */
export function adoptTtsUsage(usage: TtsDailyUsage | null): void {
  globalTtsUsageState.current = usage;
  saveGlobalStateInBackground("record TTS daily usage");
}

/**
 * 全局状态的 durability barrier。值在调用同步栈内完成序列化，
 * 返回的 Promise 只会在对应 revision（或更新 revision）落盘后完成。
 *
 * @param context 触发持久化的业务上下文描述（用于错误日志）。
 */
export async function persistGlobalState(context: string): Promise<void> {
  throwIfUpdateAborted();
  try {
    await sharedStateStore().save(currentGlobalState());
    throwIfUpdateAborted();
  } catch (error: unknown) {
    throwIfUpdateAborted();
    const reason: Error = toError(error);
    throw new Error(`Failed to persist global state update (${context}): ${reason.message}`, { cause: error });
  }
}

/**
 * 注册全局状态持久化连续失败耗尽时的 fatal 回调。
 *
 * @param handler 致命错误回调。
 */
export function setStatePersistenceFatalHandler(handler: ((error: Error) => void) | undefined): void {
  sharedStateStore().setFatalHandler(handler);
}

/**
 * 在后台合并窗口内异步持久化当前全局状态，失败时记录错误日志。
 *
 * @param context 触发后台保存的业务上下文描述。
 */
function saveGlobalStateInBackground(context: string): void {
  throwIfUpdateAborted();
  void sharedStateStore().save(currentGlobalState(), { waitForPersistence: false }).catch((error: unknown): void => {
    logger.error(`Failed to persist background global state update (${context}):`, error);
  });
}

/**
 * 在 timeoutMs 预算内排空全局状态写入；quiesce 为 true 时此后不再接受新写入（停机最后一刷）。
 *
 * @param timeoutMs 最大等待超时时间（毫秒）。
 * @param quiesce 是否同时封口后续写入。
 * @returns 刷盘结算结果。
 */
export function flushStateToDisk(timeoutMs: number, quiesce: boolean): Promise<FlushResult> {
  return sharedStateStore().flush(timeoutMs, quiesce);
}
