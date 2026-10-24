import { avatarDrainWaiters, avatarUpdateRuntime, avatarUpdateState } from "../cache/main/copy/avatar";
import type { FlushResult } from "../types/lifecycle";
import { drainWithWaiter, settleFlushWaiters } from "../libs/drainWaiter";
import { logger } from "../infra/logger";
import { copyUserProfilePhoto } from "../infra/telegram/avatar/copy";
import { restoreDefaultProfilePhoto } from "../infra/telegram/avatar/restore";
import { getAssetConfig } from "../config/assets";
import { sendCommandMessage } from "../infra/telegram";
import { updateTopicThreadIdFor } from "../infra/updateContext";
import { chatAtmosphere } from "../infra/atmosphere";
import { formatUserLabel } from "../users/userLabel";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { AvatarUpdateRequest, AvatarUpdateTask } from "../types/copy/avatar";

/**
 * 渲染头像更新或复原后的群内操作回执文案。
 *
 * @param task 头像更新任务
 * @param updated 头像是否更新成功
 * @returns 对应氛围下的操作回执文本
 */
function renderAvatarNotice(task: AvatarUpdateTask, updated: boolean): string {
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  if (task.target.kind === "default") {
    if (task.source === "copy") {
      return updated ? atmosphere.NOTICE_TEXTS.copyAvatarRestored : atmosphere.NOTICE_TEXTS.copyAvatarRestoreFailed;
    }
    return updated ? atmosphere.NOTICE_TEXTS.iconRestored : atmosphere.NOTICE_TEXTS.iconRestoreFailed;
  }
  const label: string = formatUserLabel(task.target.user, atmosphere);
  if (task.source === "copy") {
    return updated ? atmosphere.NOTICE_TEXTS.copyAvatarChanged(label) : atmosphere.NOTICE_TEXTS.copyAvatarFailed(label);
  }
  return updated ? atmosphere.NOTICE_TEXTS.iconChanged(label) : atmosphere.NOTICE_TEXTS.iconFailed(label);
}

/** 执行槽与待执行槽均空闲时唤醒所有排空等待者。 */
function notifyAvatarDrainIfIdle(): void {
  if (avatarUpdateState.running || avatarUpdateState.pending !== null) return;
  settleFlushWaiters(avatarDrainWaiters, "flushed");
}

/** 串行消费 latest-only 头像更新槽中的待执行任务。 */
async function consumeAvatarUpdates(): Promise<void> {
  if (avatarUpdateState.running) return;
  avatarUpdateState.running = true;
  try {
    while (avatarUpdateState.pending !== null) {
      const task: AvatarUpdateTask = avatarUpdateState.pending;
      avatarUpdateState.pending = null;
      const signal: AbortSignal = avatarUpdateRuntime.controller.signal;
      if (signal.aborted) break;
      try {
        // 复制头像与复原默认头像共用同一执行槽，latest-only 语义对两类目标通用：
        // 连续执行 /icon steal 与 /icon reset 时，最终生效的是最后提交的目标。
        // 默认头像的来源在这里从主线程素材快照取好再传入；avatar/restore.ts 不读取
        // 素材快照（见 config/assets.ts 的 getAssetConfig）。
        const updated: boolean = task.target.kind === "default"
          ? await restoreDefaultProfilePhoto(getAssetConfig().botDefaultAvatar, signal)
          : await copyUserProfilePhoto(
            task.target.user.id,
            !!task.target.user.isChannel,
            { username: task.target.user.username, signal }
          );
        // 新目标入队时不打断已在途的请求，但已被新代际取代的旧请求不再发送回执；
        // 停机取消则由 signal 终止在途请求。最终仅最新代际报告结果，随后继续消费 pending。
        if (!task.silent && !signal.aborted && task.generation === avatarUpdateState.latestGeneration) {
          await sendCommandMessage({
            chatId: task.chatId,
            text: renderAvatarNotice(task, updated),
            messageThreadId: task.messageThreadId,
            signal,
          });
        }
      } catch (error: unknown) {
        if (signal.aborted) break;
        logger.error("Error in background avatar update task:", error);
      }
    }
  } finally {
    avatarUpdateState.running = false;
    notifyAvatarDrainIfIdle();
    // 循环因取消 break 或 catch 块内抛错提前退出时，期间新到的 pending 还没被消费；
    // 重新取得唯一执行槽处理它。
    if (avatarUpdateState.pending !== null) void consumeAvatarUpdates();
  }
}

/**
 * 提交头像更新目标；运行中仅保留最新一份请求，历史请求不会形成 Promise 链。
 * 回执在异步执行槽里发出时已脱离触发它的 update 作用域，因此在提交时捕获触发话题。
 *
 * @param params 头像更新请求（含目标群聊 `chatId`、头像目标 `target`、触发来源 `source` 与是否静默 `silent`）。
 */
export function queueAvatarUpdate({ chatId, target, source, silent = false }: AvatarUpdateRequest): void {
  if (!avatarUpdateRuntime.accepting) return;
  const generation: number = avatarUpdateState.nextGeneration++;
  avatarUpdateState.latestGeneration = generation;
  avatarUpdateState.pending = {
    generation,
    chatId,
    target,
    source,
    messageThreadId: updateTopicThreadIdFor(chatId),
    silent,
  };
  void consumeAvatarUpdates();
}

/**
 * 生命周期边界：等待当前执行槽和 latest-only 待执行槽归零。
 *
 * @param timeoutMs 最大等待毫秒数
 * @returns 排空结果（`flushed` 或 `timedOut`）
 */
export function drainAvatarUpdates(timeoutMs: number): Promise<FlushResult> {
  return drainWithWaiter({
    owner: "Avatar",
    timeoutMs,
    isIdle: (): boolean => !avatarUpdateState.running && avatarUpdateState.pending === null,
    waiters: avatarDrainWaiters,
    notifyIfIdle: notifyAvatarDrainIfIdle,
    abort: abortAvatarUpdates,
  });
}

/** 初始化头像更新队列运行态并开放任务接纳。 */
export function initAvatarUpdates(): void {
  if (avatarUpdateState.running) throw new Error("Cannot initialize avatar updates while a task is active.");
  avatarUpdateState.pending = null;
  avatarUpdateRuntime.controller = new AbortController();
  avatarUpdateRuntime.accepting = true;
}

/** 停止接纳新的头像更新请求。 */
export function quiesceAvatarUpdates(): void {
  avatarUpdateRuntime.accepting = false;
}

/** 取消在途头像更新请求并清空待执行槽。 */
function abortAvatarUpdates(): void {
  avatarUpdateRuntime.accepting = false;
  avatarUpdateState.pending = null;
  avatarUpdateState.latestGeneration = avatarUpdateState.nextGeneration++;
  if (!avatarUpdateRuntime.controller.signal.aborted) avatarUpdateRuntime.controller.abort();
  notifyAvatarDrainIfIdle();
}
