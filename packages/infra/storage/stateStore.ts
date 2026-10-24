import type { FlushResult } from "../../types/lifecycle";
import { chatStateCache } from "../../cache/main/chatState";
import { globalCopyState, globalTtsUsageState, stateStoreHolder } from "../../cache/main/storage";
import {
  DEFAULT_CHAT_STATE,
  createChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../../libs/chatState";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type {
  CachedUser,
  ChatState,
  ChatStateOptionalField,
  ChatStateSwitchKey,
  CopyMode,
  DecodedGlobalCopyState,
  DecodedGlobalState,
  GlobalCopyState,
  GlobalState,
} from "../../types/chatState";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { assertChatStateCapacity } from "../chatStateStorage";
import { StateStore, loadCurrentGlobalState } from "./statePersistence";
import { toError } from "../../libs/errorMessage";

export {
  hydrateChatStateCache,
  persistChatState,
  saveChatStateInBackground,
} from "../chatStateStorage";

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
 * 获取主线程按群状态缓存的只读映射视图。
 *
 * @returns 群聊 ID 到群状态的只读 Map。
 */
export function getChatStateCache(): ReadonlyMap<number, ChatState> {
  return chatStateCache;
}

/**
 * 查找当前开启了代发模式（`isProxySendEnabled`）的目标群聊 ID。
 *
 * @returns 开启代发模式的群聊 ID；没有任何群开启时返回 `undefined`。
 */
export function getActiveProxySendTarget(): number | undefined {
  for (const [chatId, chatState] of chatStateCache) {
    if (chatState.isProxySendEnabled === true) return chatId;
  }
  return undefined;
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

/** 启动恢复：经 loadCurrentGlobalState 拒绝未迁移的状态文件，再从 memory/global/state.json 恢复全局状态。 */
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

/**
 * 只读地查一个群的状态。没有条目时返回全局共享的 `DEFAULT_CHAT_STATE`，
 * 返回类型为 `Readonly<ChatState>`。要修改状态的调用方一律走 `getOrCreateChatState`。
 *
 * @param chatId 群聊 ID。
 * @returns 群状态的只读视图。
 */
export function getChatState(chatId: number): Readonly<ChatState> {
  return chatStateCache.get(chatId) ?? DEFAULT_CHAT_STATE;
}

/**
 * 取可写的群状态；没有条目时先过容量闸（infra/chatStateStorage.ts 的
 * assertChatStateCapacity），再以规范形状新建并登记。
 *
 * @param chatId 群聊 ID。
 * @returns 群状态的可写引用。
 */
export function getOrCreateChatState(chatId: number): ChatState {
  let chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (!chatState) {
    assertChatStateCapacity(chatId);
    // 规范形状一次建好；写入方只赋值，不往裸 `{}` 上一个个加字段（见
    // libs/chatState.ts 的 createChatState）。
    chatState = createChatState();
    chatStateCache.set(chatId, chatState);
  }
  return chatState;
}

/**
 * 收敛刚被清除字段的群状态；整条回到缺省时摘除热读副本条目。
 *
 * @param chatId 群聊 ID。
 * @param chatState 刚被修改的群状态对象。
 */
function settleClearedChatState(chatId: number, chatState: ChatState): void {
  normalizeChatState(chatState);
  if (isEmptyChatState(chatState)) chatStateCache.delete(chatId);
}

/**
 * 清除一个可选字段（置为 undefined）。字段本来就没设过时返回 false，不改动状态。
 * 调用方负责随后落盘。
 *
 * @param chatId 群聊 ID。
 * @param field 要清除的可选字段名。
 * @returns 实际清除了已有字段值时返回 `true`。
 */
export function clearChatStateField(chatId: number, field: ChatStateOptionalField): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[field] === undefined) return false;
  chatState[field] = undefined;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 关闭一个群开关（置为 false）。开关本来就是关闭时返回 false，不改动状态。
 * 调用方负责随后落盘。
 *
 * @param chatId 群聊 ID。
 * @param key 要关闭的布尔开关字段名。
 * @returns 实际将已开启开关置为关闭时返回 `true`。
 */
export function disableChatStateSwitch(chatId: number, key: ChatStateSwitchKey): boolean {
  const chatState: ChatState | undefined = chatStateCache.get(chatId);
  if (chatState?.[key] !== true) return false;
  chatState[key] = false;
  settleClearedChatState(chatId, chatState);
  return true;
}

/**
 * 停管一个群时删除它的全部配置，但保留尚需恢复的 lockdown write-ahead 记录。
 *
 * 两条路径共用：`/init disable`（见 commands/init.ts）与机器人被移出群（见
 * infra/botAdmin.ts）。lockdown 是唯一例外：反刷群恢复流程仍要用它的
 * originalPermissions 解锁（同 libs/chatState.ts 的 normalizeChatState）。
 *
 * 无记录时不做任何事；调用方负责在同一 teardown 尾部统一落盘。清完后若整条状态
 * 回到缺省，这里会删掉热读副本条目，随后的 persistChatState 写出删除墓碑，SQLite 行
 * 一并消失（见 infra/chatStateStorage.ts 的 encodeCurrentChatState）。
 *
 * @param chatId 群聊 ID。
 */
export function purgeChatStateExceptLockdown(chatId: number): void {
  const current: ChatState | undefined = chatStateCache.get(chatId);
  if (!current) return;
  if (current.lockdown === undefined) {
    chatStateCache.delete(chatId);
    return;
  }
  const retained: ChatState = createChatState();
  retained.lockdown = current.lockdown;
  chatStateCache.set(chatId, retained);
}
