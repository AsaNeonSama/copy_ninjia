import {
  getPendingBlockedRemovalParams,
  persistPendingBlockedRemovals,
} from "../infra/blocklist/outbox";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import {
  retainCurrentlyBlockedIdentityIds,
} from "../infra/identityStorage";
import { logger } from "../infra/logger";
import { BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS } from "../consts/antiRaid/blocklist";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../types/blocklist";

/**
 * 判断两份补扫页或处置名单是否包含相同顺序的主键序列。
 *
 * @param left 第一份身份 ID 序列
 * @param right 第二份身份 ID 序列
 * @returns 长度与逐项顺序均一致时返回 true，否则返回 false
 */
function blocklistPagesMatch(
  left: readonly number[],
  right: readonly number[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index: number = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 按主线程权威镜像对账处置消息：移除已取消的批次，并在批次取消时补回被其取代的 join 消息。
 *
 * @param messages 待对账的 Anti-Raid Worker 消息列表
 * @param replacedJoins removalId -> 被取代的 join 消息（由 claimBlockedJoiner 登记）。
 * @param filterProbeIds 是否对 `probeMembership` 批次重读当前黑名单身份集合过滤已解封项
 * @returns 与当前权威黑名单镜像一致的待投递消息列表
 */
async function reconcileBlockedRemovalMessages(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins: ReadonlyMap<number, AntiRaidWorkerMessage>,
  filterProbeIds: boolean
): Promise<AntiRaidWorkerMessage[]> {
  const reconciled: AntiRaidWorkerMessage[] = [];
  let previousProbeIds: readonly number[] | null = null;
  let previousRetainedIds: readonly number[] = [];
  for (const message of messages) {
    if (message.type !== "removeBlockedMembers") {
      reconciled.push(message);
      continue;
    }
    let blockedIds: readonly number[] = message.userIds;
    if (message.probeMembership && filterProbeIds) {
      if (
        previousProbeIds !== null &&
        blocklistPagesMatch(previousProbeIds, message.userIds)
      ) {
        blockedIds = previousRetainedIds;
      } else {
        blockedIds = await retainCurrentlyBlockedIdentityIds(message.userIds);
        previousProbeIds = message.userIds;
        previousRetainedIds = blockedIds;
      }
    }
    const params: RemoveBlockedMembersParams | undefined =
      getPendingBlockedRemovalParams(message.removalId, blockedIds);
    if (params !== undefined) {
      reconciled.push({ type: "removeBlockedMembers", ...params });
      continue;
    }
    const replacedJoin: AntiRaidWorkerMessage | undefined = replacedJoins.get(message.removalId);
    if (replacedJoin !== undefined) reconciled.push(replacedJoin);
  }
  return reconciled;
}

/**
 * 判断对账前后的消息列表是否描述同一批权威任务。
 *
 * @param left 对账或落盘前的消息列表
 * @param right 落盘后重读对账的消息列表
 * @returns 两份列表长度与每项权威任务语义一致时返回 true，否则返回 false
 */
function durableAntiRaidMessagesMatch(
  left: readonly AntiRaidWorkerMessage[],
  right: readonly AntiRaidWorkerMessage[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index: number = 0; index < left.length; index++) {
    const leftMessage: AntiRaidWorkerMessage | undefined = left[index];
    const rightMessage: AntiRaidWorkerMessage | undefined = right[index];
    if (leftMessage === undefined || rightMessage === undefined) return false;
    if (
      leftMessage.type !== "removeBlockedMembers" ||
      rightMessage.type !== "removeBlockedMembers"
    ) {
      if (leftMessage !== rightMessage) return false;
      continue;
    }
    if (
      leftMessage.removalId !== rightMessage.removalId ||
      leftMessage.chatId !== rightMessage.chatId ||
      leftMessage.probeMembership !== rightMessage.probeMembership ||
      leftMessage.joinedAt !== rightMessage.joinedAt ||
      leftMessage.announcementMessageId !== rightMessage.announcementMessageId
    ) {
      return false;
    }
    if (leftMessage.probeMembership) continue;
    if (!blocklistPagesMatch(leftMessage.userIds, rightMessage.userIds)) return false;
  }
  return true;
}

/**
 * 持久化并复核待投递的黑名单处置消息，最多迭代 BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS 轮，
 * 直至已落盘内容与当前权威镜像一致。超出轮次上限时剥离处置批次并为受影响群标记补扫（requestBlocklistResweep）。
 *
 * @param messages 待投递的原始 Anti-Raid Worker 消息批次
 * @param replacedJoins removalId -> 被取代的 join 消息（由 claimBlockedJoiner 登记）。
 * @returns 已完成持久化与对账、可安全投递给 Worker 的消息列表
 */
export async function prepareDurableAntiRaidMessages(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins: ReadonlyMap<number, AntiRaidWorkerMessage> = new Map()
): Promise<AntiRaidWorkerMessage[]> {
  let durableMessages: AntiRaidWorkerMessage[] =
    await reconcileBlockedRemovalMessages(messages, replacedJoins, false);
  for (let round: number = 0; round < BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS; round++) {
    await persistPendingBlockedRemovals();
    const currentMessages: AntiRaidWorkerMessage[] =
      await reconcileBlockedRemovalMessages(messages, replacedJoins, true);
    if (durableAntiRaidMessagesMatch(durableMessages, currentMessages)) {
      return currentMessages;
    }
    durableMessages = currentMessages;
  }
  const stalledChatIds: Set<number> = new Set<number>();
  const withoutRemovals: AntiRaidWorkerMessage[] = [];
  for (const message of durableMessages) {
    if (message.type === "removeBlockedMembers") stalledChatIds.add(message.chatId);
    else withoutRemovals.push(message);
  }
  logger.error(
    `Blocklist removal messages kept changing across ${BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS} durability rounds; ` +
    `withholding the batches for ${stalledChatIds.size} chat(s), which stay in the durable outbox and now owe a resweep.`
  );
  for (const chatId of stalledChatIds) requestBlocklistResweep(chatId);
  return withoutRemovals;
}
