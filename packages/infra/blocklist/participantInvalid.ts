/**
 * 黑名单销号识别：按补扫回执维护 `participantInvalidCount`，达到 BLOCKLIST_PARTICIPANT_INVALID_LIMIT
 * 时自动解除拉黑并裁剪待踢任务，参见 docs/cn/04-invariants.md。
 */

import {
  blocklistIdentityMutationRunner,
  blocklistParticipantInvalidQueue,
  pendingParticipantInvalidUnblocks,
} from "../../cache/main/blocklist";
import {
  BLOCKLIST_PARTICIPANT_INVALID_LIMIT,
  BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS,
} from "../../consts/antiRaid/blocklist";
import {
  cachedBlocklistEntry,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  retainParticipantInvalidBlocklistIds,
} from "../identityStorage";
import { logger } from "../logger";
import { unblockUser } from "./membership";
import type { BlockedMembersRemovedEvent } from "../../types/antiRaid/events";
import type { BlocklistEntryData } from "../../types/identityPolicy";

/**
 * 检查给定的全部身份 ID 是否均已命中主线程身份策略缓存。
 *
 * @param ids 待检查的身份 ID 只读列表。
 * @returns 全部身份均已在缓存中时返回 `true`，任一身份未命中缓存时返回 `false`。
 */
function allIdentityPoliciesCached(ids: readonly number[]): boolean {
  for (const id of ids) {
    if (!isIdentityPolicyCached(id)) return false;
  }
  return true;
}

/**
 * 校验当前解除尝试未被后续计数清零/改写覆盖，且黑名单关键字段（`blockedAt`、`participantInvalidCount`）
 * 未变化后解除已判定销号用户的黑名单记录（即使期间条目曾被 LRU 淘汰重读亦可通过）。
 *
 * @param userId 已达到连续 `PARTICIPANT_ID_INVALID` 阈值的用户 ID。
 * @param expected 触发自动解除拉黑时观测到的黑名单条目快照。
 * @param token 本次自动解除尝试的独占令牌。
 */
async function unblockDeletedAccount(
  userId: number,
  expected: Readonly<BlocklistEntryData>,
  token: symbol
): Promise<void> {
  try {
    if (pendingParticipantInvalidUnblocks.get(userId) !== token) return;
    if (!await prefetchIdentityPolicies([userId])) return;
    if (pendingParticipantInvalidUnblocks.get(userId) !== token) return;
    const current: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(userId);
    if (
      !isIdentityPolicyCached(userId) ||
      current?.blockedAt !== expected.blockedAt ||
      current?.participantInvalidCount !== expected.participantInvalidCount
    ) return;
    unblockUser(userId);
    logger.info(
      "Removed blocklisted user after consecutive PARTICIPANT_ID_INVALID sweep results.",
      { userId, consecutiveLimit: BLOCKLIST_PARTICIPANT_INVALID_LIMIT }
    );
  } finally {
    if (pendingParticipantInvalidUnblocks.get(userId) === token) {
      pendingParticipantInvalidUnblocks.delete(userId);
    }
  }
}

/**
 * 同步写出单条回执对应的销号计数递增、清零或解除拉黑操作。
 *
 * @param participantInvalidUserIds 本次补扫返回 `PARTICIPANT_ID_INVALID` 的身份 ID 列表。
 * @param resettableUserIds 本次补扫确认账号仍可解析且需清零连续无效计数的身份 ID 列表。
 */
function applyParticipantReadability(
  participantInvalidUserIds: readonly number[],
  resettableUserIds: readonly number[]
): void {
  for (const userId of resettableUserIds) {
    pendingParticipantInvalidUnblocks.delete(userId);
    const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(userId);
    if (entry?.participantInvalidCount === undefined) continue;
    queueIdentityPolicyWrite("blocklist", userId, {
      blockedAt: entry.blockedAt,
      meta: entry.meta,
    });
  }
  for (const userId of participantInvalidUserIds) {
    const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(userId);
    if (entry === undefined) continue;
    const count: number = (entry.participantInvalidCount ?? 0) + 1;
    if (count < BLOCKLIST_PARTICIPANT_INVALID_LIMIT) {
      pendingParticipantInvalidUnblocks.delete(userId);
      queueIdentityPolicyWrite("blocklist", userId, {
        blockedAt: entry.blockedAt,
        meta: entry.meta,
        participantInvalidCount: count,
      });
      continue;
    }
    const token: symbol = Symbol("participant-invalid-unblock");
    pendingParticipantInvalidUnblocks.set(userId, token);
    void blocklistIdentityMutationRunner.run(
      userId,
      (): Promise<void> => unblockDeletedAccount(userId, entry, token)
    ).catch((error: unknown): void => {
      logger.error("Failed to remove deleted account from the blocklist:", { userId }, error);
    });
  }
}

/**
 * 预热需改写的黑名单条目并在全部命中缓存后应用销号计数更新（最多重试 BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS 次）。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 */
async function settleParticipantReadability(
  event: BlockedMembersRemovedEvent
): Promise<void> {
  const { participantInvalidUserIds, settledUserIds }: BlockedMembersRemovedEvent = event;
  const resettableUserIds: readonly number[] = settledUserIds.length === 0
    ? settledUserIds
    : await retainParticipantInvalidBlocklistIds(settledUserIds);
  if (participantInvalidUserIds.length === 0 && resettableUserIds.length === 0) return;
  const ids: readonly number[] = [...participantInvalidUserIds, ...resettableUserIds];
  for (let attempt: number = 1; attempt <= BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS; attempt++) {
    if (!await prefetchIdentityPolicies(ids)) return;
    if (allIdentityPoliciesCached(ids)) {
      applyParticipantReadability(participantInvalidUserIds, resettableUserIds);
      return;
    }
  }
  logger.error(
    "Skipped blocklist PARTICIPANT_ID_INVALID counts; identities left policy cache before write attempts completed.",
    {
      removalId: event.removalId,
      chatId: event.chatId,
      maxAttempts: BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS,
    }
  );
}

/**
 * 将处置回执中的销号观测排入主线程串行更新队列。
 *
 * @param event Anti-Raid Worker 上报的黑名单成员处置完成事件。
 */
export function recordBlocklistParticipantReadability(
  event: BlockedMembersRemovedEvent
): void {
  if (event.participantInvalidUserIds.length === 0 && event.settledUserIds.length === 0) return;
  const step: Promise<void> = blocklistParticipantInvalidQueue.current.then(
    (): Promise<void> => settleParticipantReadability(event)
  );
  blocklistParticipantInvalidQueue.current = step.catch((error: unknown): void => {
    logger.error(
      "Failed to update blocklist PARTICIPANT_ID_INVALID counts:",
      { removalId: event.removalId, chatId: event.chatId },
      error
    );
  });
}
