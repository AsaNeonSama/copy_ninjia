/**
 * 黑名单移除副作用（入群守卫线程侧）：探测成员、执行封禁、线性退避重试，以及秒踢路径的入群计数与入群公告删除（约束见 docs/cn/04-invariants.md）。
 *
 * 整批任务登记在在途集合并订阅停机取消信号（antiRaidDispatchSignal）；取消后按未完成回执，由主线程持久镜像在下次启动重放。
 */

import { banChatMemberWithOutcome, banChatSenderChatWithOutcome, deleteMessage, probeChatAdmin, telegramApi } from "../../infra/telegram";
import type { BanChatMemberOutcome } from "../../infra/telegram";
import { probeChatMembershipWithOutcome } from "../../infra/telegram/actions/membership";
import type { ChatMembershipProbeOutcome } from "../../infra/telegram/actions/membership";
import { logger } from "../../infra/logger";
import { botCanDeleteIn, botCanRestrictIn } from "./botPermissions";
import { recordJoin } from "./lockdownRuntime";
import { currentBlocklistRemovalEpoch } from "../../cache/workers/antiRaid/blocklist";
import {
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS,
  BLOCKLIST_SWEEP_BATCH_SIZE,
} from "../../consts/antiRaid/blocklist";
import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import type { BlockedMembersRemovedEvent } from
  "../../types/antiRaid/events";
import type { RemoveBlockedMembersMessage } from
  "../../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../../types/blocklist";
import { antiRaidDispatchSignal } from "../../cache/workers/antiRaid/tasks";
import { trackAntiRaidTask } from "./taskTracker";
import { releaseAdDetectDedupKey } from "./adDetect/queueState";
import { sleepUnlessAborted } from "../../libs/sleep";

/**
 * 单个目标的移除结局（约束见 docs/cn/04-invariants.md）：
 * - `forbidden`：机器人缺少封禁权限；
 * - `targetIsAdmin`：目标自身是群管理员，仅结算该目标；
 * - `participantInvalid`：全部尝试均返回 PARTICIPANT_ID_INVALID。
 */
type RemovalOutcome = "removed" | "absent" | "failed" | "forbidden" | "targetIsAdmin" | "participantInvalid";

export interface RemoveOneParams {
  chatId: number;
  userId: number;
  probeMembership: boolean;
  /** 本批开始时取得的停机取消信号（antiRaidDispatchSignal）。 */
  signal: AbortSignal;
}

/**
 * 处置单个目标，失败按线性退避重试；停机取消后不再进入下一次退避。
 */
async function removeOne({ chatId, userId, probeMembership, signal }: RemoveOneParams): Promise<RemovalOutcome> {
  let participantInvalid: boolean = probeMembership && userId > 0;
  for (let attempt: number = 1; attempt <= BLOCKLIST_REMOVAL_MAX_ATTEMPTS; attempt++) {
    // 频道身份（负 ID）直接封禁其在本群的发言权。
    if (userId < 0) {
      const outcome: BanChatMemberOutcome = await banChatSenderChatWithOutcome(chatId, userId, telegramApi);
      if (outcome === "banned") return "removed";
      if (outcome === "forbidden") return "forbidden";
    } else {
      if (probeMembership) {
        const probe: ChatMembershipProbeOutcome =
          await probeChatMembershipWithOutcome(chatId, userId, telegramApi);
        // 仅在确认不在群时跳过；探测失败时继续执行封禁。
        if (probe === "absent") return "absent";
        if (probe !== "participantInvalid") participantInvalid = false;
      }
      const outcome: BanChatMemberOutcome = await banChatMemberWithOutcome(chatId, userId, telegramApi);
      if (outcome === "banned") return "removed";
      if (outcome !== "participantInvalid") participantInvalid = false;
      // 权限被拒时先探测目标是否为管理员，区分 targetIsAdmin 与群级 forbidden。
      if (outcome === "forbidden") {
        return await probeChatAdmin({ chatId, userId }) === true
          ? "targetIsAdmin"
          : "forbidden";
      }
    }
    if (attempt < BLOCKLIST_REMOVAL_MAX_ATTEMPTS) {
      if (!await sleepUnlessAborted(BLOCKLIST_REMOVAL_RETRY_DELAY_MS * attempt, signal)) return "failed";
    }
  }
  return participantInvalid ? "participantInvalid" : "failed";
}

/** 一批处置的汇总结局。 */
interface RemoveBatchResult {
  /** 是否全部目标均已落定（removed 或 absent）。 */
  complete: boolean;
  /** 未落定原因中是否包含机器人缺封禁权限。 */
  permissionDenied: boolean;
  /** 是否有目标因自身管理员身份未能封禁（主线程据此保留该群补扫欠账）。 */
  targetIsAdmin: boolean;
  /** 结局为 participantInvalid 的用户 ID，按处置顺序。 */
  readonly participantInvalidUserIds: number[];
  /** 结局为 removed、absent 或 targetIsAdmin 的用户 ID，按处置顺序；不含频道 ID。 */
  readonly settledUserIds: number[];
}

interface ApplyRemovalOutcomeParams {
  readonly chatId: number;
  readonly userId: number;
  readonly outcome: RemovalOutcome;
  readonly result: RemoveBatchResult;
}

/**
 * 将单个目标的处置结局并入批次结果。
 * @returns false 表示机器人缺少封禁权限，终止剩余批次。
 */
function applyRemovalOutcome({ chatId, userId, outcome, result }: ApplyRemovalOutcomeParams): boolean {
  if (outcome === "removed") {
    if (userId > 0) result.settledUserIds.push(userId);
  } else if (outcome === "absent") {
    result.settledUserIds.push(userId);
  } else if (outcome === "forbidden") {
    result.complete = false;
    result.permissionDenied = true;
    logger.error(
      `Blocklist removal in chat ${chatId} is blocked by missing ban rights; stopping this batch.`
    );
    return false;
  } else if (outcome === "targetIsAdmin") {
    result.targetIsAdmin = true;
    result.settledUserIds.push(userId);
    logger.error(
      `Blocklisted user ${userId} is an administrator of chat ${chatId} and cannot be banned; ` +
      "settling this target and continuing with the rest of the batch."
    );
  } else {
    result.complete = false;
    if (outcome === "participantInvalid") result.participantInvalidUserIds.push(userId);
  }
  return true;
}

interface FinishRemovalBatchParams {
  readonly chatId: number;
  /** 批次开始时的处置世代；群在这期间被停管时不再删公告。 */
  readonly epoch: number;
  readonly announcementMessageId: number | undefined;
  readonly removed: number;
}

/** 批次收尾：删除入群公告并记录移除人数。 */
async function finishRemovalBatch({
  chatId,
  epoch,
  announcementMessageId,
  removed,
}: FinishRemovalBatchParams): Promise<void> {
  if (
    announcementMessageId !== undefined &&
    currentBlocklistRemovalEpoch(chatId) === epoch &&
    botCanDeleteIn(chatId) !== false
  ) {
    await deleteMessage(chatId, announcementMessageId, telegramApi);
  }
  if (removed > 0) logger.log(`Removed ${removed} blocklisted member(s) from chat ${chatId}.`);
}

/** 逐个处置一批黑名单目标并返回汇总结果。 */
async function removeBlockedMembers({
  chatId,
  userIds,
  probeMembership,
  joinedAt,
  announcementMessageId,
}: RemoveBlockedMembersParams): Promise<RemoveBatchResult> {
  // 黑名单入群不走 join 事件，在此按窗口内有效入群补记反刷群计数。
  if (joinedAt !== undefined) {
    const now: number = Date.now();
    if (now - joinedAt < JOIN_WINDOW_MS) recordJoin(chatId, now);
  }
  const epoch: number = currentBlocklistRemovalEpoch(chatId);
  const signal: AbortSignal = antiRaidDispatchSignal();
  let removed: number = 0;
  const result: RemoveBatchResult = {
    complete: true,
    permissionDenied: false,
    targetIsAdmin: false,
    participantInvalidUserIds: [],
    settledUserIds: [],
  };
  if (botCanRestrictIn(chatId) === false) {
    result.complete = false;
    result.permissionDenied = true;
    await finishRemovalBatch({ chatId, epoch, announcementMessageId, removed });
    return result;
  }
  for (let index: number = 0; index < userIds.length; index++) {
    if (currentBlocklistRemovalEpoch(chatId) !== epoch) {
      result.complete = false;
      return result;
    }
    if (signal.aborted) {
      result.complete = false;
      return result;
    }
    if (
      index > 0 &&
      index % BLOCKLIST_SWEEP_BATCH_SIZE === 0 &&
      !await sleepUnlessAborted(BLOCKLIST_SWEEP_BATCH_PAUSE_MS, signal)
    ) {
      result.complete = false;
      return result;
    }
    const userId: number = userIds[index]!;
    const outcome: RemovalOutcome = await removeOne({ chatId, userId, probeMembership, signal });
    if (outcome === "removed") removed++;
    if (!applyRemovalOutcome({ chatId, userId, outcome, result })) break;
  }
  await finishRemovalBatch({ chatId, epoch, announcementMessageId, removed });
  return result;
}

export interface HandleRemoveBlockedMembersParams {
  msg: RemoveBlockedMembersMessage;
  /** 回执通道（Worker -> 主线程）；由 antiRaidWorker.ts 注入 self.postMessage。 */
  publish: (event: BlockedMembersRemovedEvent) => void;
}

/** 启动黑名单移除后台任务并在结束时回执主线程。 */
export function handleRemoveBlockedMembers({ msg, publish }: HandleRemoveBlockedMembersParams): Promise<void> {
  const task: Promise<void> = removeBlockedMembers(msg)
    .then((result: RemoveBatchResult): void => {
      publish({
        type: "blockedMembersRemoved",
        chatId: msg.chatId,
        removalId: msg.removalId,
        complete: result.complete,
        permissionDenied: result.permissionDenied,
        targetIsAdmin: result.targetIsAdmin,
        participantInvalidUserIds: result.participantInvalidUserIds,
        settledUserIds: result.settledUserIds,
      });
      if (result.complete && !result.targetIsAdmin && !msg.probeMembership) {
        try {
          for (const userId of msg.userIds) {
            releaseAdDetectDedupKey(msg.chatId, userId);
          }
        } catch (error: unknown) {
          logger.error(
            `Failed to release ad-detect disposal markers for chat ${msg.chatId}:`,
            error
          );
        }
      }
    })
    .catch((error: unknown): void => {
      logger.error(`Failed to remove blocklisted members from chat ${msg.chatId}:`, error);
      publish({
        type: "blockedMembersRemoved",
        chatId: msg.chatId,
        removalId: msg.removalId,
        complete: false,
        permissionDenied: false,
        targetIsAdmin: false,
        participantInvalidUserIds: [],
        settledUserIds: [],
      });
    });
  return trackAntiRaidTask({ task, blocklistChatId: msg.chatId });
}
