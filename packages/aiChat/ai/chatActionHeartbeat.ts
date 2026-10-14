import { typingHeartbeats } from "../../cache/workers/aiChat/heartbeat";
import {
  CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  CHAT_ACTION_REST_MS,
  TYPING_ACTION_INTERVAL_MS,
} from "../../consts/aiChat/tools";
import { sendChatAction } from "../../infra/telegram";
import { trackInflight } from "../../libs/inflight";
import type { ChatActionHeartbeatControl, ChatActionHeartbeatEntry, ChatActionPhase } from "../../types/aiChat/chatAction";
import type { TelegramChatAction } from "../../types/telegram";

/** 单次聊天状态发送请求参数。 */
export interface ChatActionSendRequest {
  action: TelegramChatAction;
  chatId: number;
  /** 目标论坛话题 ID；非话题场景为 undefined。 */
  messageThreadId: number | undefined;
  signal?: AbortSignal;
}

/** 聊天状态心跳依赖项。 */
export interface ChatActionHeartbeatDependencies {
  entries: Map<number, ChatActionHeartbeatEntry>;
  intervalMs: number;
  maxConsecutiveFailures: number;
  /** 状态结束切回 idle 后到下一段状态点亮前的最短静默毫秒数。 */
  restMs: number;
  /** 状态发送函数。 */
  sendChatAction(request: ChatActionSendRequest): Promise<boolean>;
}

const DEFAULT_DEPENDENCIES: ChatActionHeartbeatDependencies = {
  entries: typingHeartbeats,
  intervalMs: TYPING_ACTION_INTERVAL_MS,
  maxConsecutiveFailures: CHAT_ACTION_MAX_CONSECUTIVE_FAILURES,
  restMs: CHAT_ACTION_REST_MS,
  sendChatAction,
};

export interface PumpChatActionParams {
  chatId: number;
  entry: ChatActionHeartbeatEntry;
  deduplicate: boolean;
  dependencies: ChatActionHeartbeatDependencies;
}

/**
 * 将状态发送请求排入本群串行链（最多合并保留一发待执行请求）：
 * 执行时按当前挡位与静默期判定是否发送，deduplicate 为真时跳过间隔内已送达的同挡位请求；
 * 连续失败达到阈值时停止定时器并移除条目。
 */
export function pumpChatAction({
  chatId,
  entry,
  deduplicate,
  dependencies,
}: PumpChatActionParams): void {
  if (entry.pendingSend) {
    entry.pendingSendDeduplicate &&= deduplicate;
    return;
  }
  entry.pendingSend = true;
  entry.pendingSendDeduplicate = deduplicate;
  const run = async (): Promise<void> => {
    const deduplicable: boolean = entry.pendingSendDeduplicate;
    entry.pendingSend = false;
    if (dependencies.entries.get(chatId) !== entry) return;
    const phase: ChatActionPhase = entry.action;
    if (phase === "idle" || performance.now() < entry.restUntil) return;
    const sinceLastSent: number = Date.now() - entry.lastSentAt;
    if (
      deduplicable &&
      entry.lastSentPhase === phase &&
      sinceLastSent >= 0 &&
      sinceLastSent < dependencies.intervalMs
    ) return;
    let ok: boolean;
    try {
      ok = await dependencies.sendChatAction({
        action: phase,
        chatId,
        messageThreadId: entry.messageThreadId,
        signal: entry.signal,
      });
    } catch {
      ok = false;
    }
    if (dependencies.entries.get(chatId) !== entry) return;
    if (ok) {
      if (entry.action === phase) {
        entry.lastSentPhase = phase;
        entry.lastSentAt = Date.now();
      }
      entry.consecutiveFailures = 0;
      return;
    }
    if (++entry.consecutiveFailures < dependencies.maxConsecutiveFailures) return;
    clearInterval(entry.timer);
    clearTimeout(entry.restTimer ?? undefined);
    dependencies.entries.delete(chatId);
  };
  entry.sendChain = entry.sendChain.then(run);
  void trackInflight(entry.inflight, entry.sendChain);
}

/**
 * 点亮条目当前挡位并返回剩余静默毫秒数：静默期已过则立即排入发送链，否则由静默定时器到期后补发。
 */
function lightChatAction(
  chatId: number,
  entry: ChatActionHeartbeatEntry,
  dependencies: ChatActionHeartbeatDependencies
): number {
  const rest: number = Math.ceil(entry.restUntil - performance.now());
  if (rest <= 0) {
    pumpChatAction({ chatId, entry, deduplicate: true, dependencies });
    return 0;
  }
  if (entry.restTimer === null) {
    entry.restTimer = setTimeout((): void => {
      entry.restTimer = null;
      if (dependencies.entries.get(chatId) === entry && entry.action !== "idle") lightChatAction(chatId, entry, dependencies);
    }, rest);
    entry.restTimer.unref();
  }
  return rest;
}

export interface StartChatActionHeartbeatParams {
  chatId: number;
  /** 本轮所在的论坛话题 ID；非话题场景为 undefined。 */
  messageThreadId: number | undefined;
  dependencies?: ChatActionHeartbeatDependencies;
  signal?: AbortSignal;
}

/**
 * 获取或创建群级聊天状态心跳句柄（按 refCount 共享条目，按 ownerToken 跟踪当前非 idle 挡位归属）：
 * 支持切换挡位、等待在途请求落定以及释放本轮句柄（定时器与生命周期约束见 docs/cn/04-invariants.md）。
 */
export function startChatActionHeartbeat({
  chatId,
  messageThreadId,
  dependencies = DEFAULT_DEPENDENCIES,
  signal,
}: StartChatActionHeartbeatParams): ChatActionHeartbeatControl {
  let entry: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
  if (entry !== undefined && entry.signal !== signal) {
    clearInterval(entry.timer);
    clearTimeout(entry.restTimer ?? undefined);
    dependencies.entries.delete(chatId);
    entry = undefined;
  }
  if (!entry) {
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      const live: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
      if (live?.timer !== timer || live.action === "idle" || performance.now() < live.restUntil) return;
      pumpChatAction({ chatId, entry: live, deduplicate: false, dependencies });
    }, dependencies.intervalMs);
    timer.unref();
    entry = {
      timer,
      signal,
      refCount: 0,
      action: "idle",
      messageThreadId: undefined,
      owner: null,
      sendChain: Promise.resolve(),
      pendingSend: false,
      pendingSendDeduplicate: true,
      lastSentPhase: "idle",
      lastSentAt: 0,
      restUntil: 0,
      restTimer: null,
      inflight: new Set(),
      consecutiveFailures: 0,
    };
    dependencies.entries.set(chatId, entry);
  }

  entry.refCount++;

  const acquired: ChatActionHeartbeatEntry = entry;
  const ownerToken: object = {};
  let released: boolean = false;
  return {
    set: (phase: ChatActionPhase): number => {
      if (released || dependencies.entries.get(chatId) !== acquired) return 0;
      if (phase === "idle") {
        if (acquired.owner !== null && acquired.owner !== ownerToken) return 0;
        acquired.restUntil = performance.now() + dependencies.restMs;
        if (acquired.owner === null) return 0;
        acquired.owner = null;
        acquired.action = "idle";
        acquired.messageThreadId = undefined;
        acquired.lastSentPhase = "idle";
        return 0;
      }
      acquired.owner = ownerToken;
      acquired.action = phase;
      acquired.messageThreadId = messageThreadId;
      return lightChatAction(chatId, acquired, dependencies);
    },
    settle: async (): Promise<void> => {
      await Promise.allSettled(acquired.inflight);
    },
    stop: async (): Promise<void> => {
      if (!released) {
        released = true;
        const current: ChatActionHeartbeatEntry | undefined = dependencies.entries.get(chatId);
        if (current === acquired) {
          if (acquired.owner === ownerToken) {
            acquired.owner = null;
            acquired.action = "idle";
            acquired.messageThreadId = undefined;
            acquired.lastSentPhase = "idle";
          }
          if (--acquired.refCount <= 0) {
            clearInterval(acquired.timer);
            clearTimeout(acquired.restTimer ?? undefined);
            dependencies.entries.delete(chatId);
          }
        }
      }
      await Promise.allSettled(acquired.inflight);
    },
  };
}
