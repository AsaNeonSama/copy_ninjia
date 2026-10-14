/**
 * 黑名单销号识别：按补扫回执维护 `participantInvalidCount`，达到 BLOCKLIST_PARTICIPANT_INVALID_LIMIT
 * 时自动解除拉黑并裁剪待踢任务，参见 docs/cn/04-invariants.md。
 */

import {
  blocklistIdentityMutationRunner,
  blocklistParticipantInvalidQueue,
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

function allIdentityPoliciesCached(ids: readonly number[]): boolean {
  for (const id of ids) {
    if (!isIdentityPolicyCached(id)) return false;
  }
  return true;
}

/** 校验缓存条目未变化后解除已判定销号用户的黑名单记录。 */
async function unblockDeletedAccount(
  userId: number,
  expected: Readonly<BlocklistEntryData>
): Promise<void> {
  if (!await prefetchIdentityPolicies([userId])) return;
  if (!isIdentityPolicyCached(userId) || cachedBlocklistEntry(userId) !== expected) return;
  unblockUser(userId);
  logger.log(
    `Removed blocklisted user ${userId} after ${BLOCKLIST_PARTICIPANT_INVALID_LIMIT} consecutive ` +
    "PARTICIPANT_ID_INVALID sweep results; treating the account as deleted."
  );
}

/** 同步写出单条回执对应的销号计数递增、清零或解除拉黑操作。 */
function applyParticipantReadability(
  participantInvalidUserIds: readonly number[],
  resettableUserIds: readonly number[]
): void {
  for (const userId of resettableUserIds) {
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
      queueIdentityPolicyWrite("blocklist", userId, {
        blockedAt: entry.blockedAt,
        meta: entry.meta,
        participantInvalidCount: count,
      });
      continue;
    }
    void blocklistIdentityMutationRunner.run(
      userId,
      (): Promise<void> => unblockDeletedAccount(userId, entry)
    ).catch((error: unknown): void => {
      logger.error(`Failed to remove deleted account ${userId} from the blocklist:`, error);
    });
  }
}

/** 预热需改写的黑名单条目并在全部命中缓存后应用销号计数更新（最多重试 BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS 次）。 */
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
    `Skipped blocklist PARTICIPANT_ID_INVALID counts for removal ${event.removalId} in chat ` +
    `${event.chatId}: identities left the policy cache before ${BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS} write attempts.`
  );
}

/** 将处置回执中的销号观测排入主线程串行更新队列。 */
export function recordBlocklistParticipantReadability(
  event: BlockedMembersRemovedEvent
): void {
  if (event.participantInvalidUserIds.length === 0 && event.settledUserIds.length === 0) return;
  const step: Promise<void> = blocklistParticipantInvalidQueue.current.then(
    (): Promise<void> => settleParticipantReadability(event)
  );
  blocklistParticipantInvalidQueue.current = step.catch((error: unknown): void => {
    logger.error(
      `Failed to update blocklist PARTICIPANT_ID_INVALID counts for removal ${event.removalId} ` +
      `in chat ${event.chatId}:`,
      error
    );
  });
}
