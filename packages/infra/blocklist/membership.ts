/**
 * 黑名单成员同步查询、增删与跨群有界并发处置入口，参见 docs/cn/04-invariants.md。
 */

import { formatLocalTime } from "../../libs/time";
import { MANAGED_CHAT_BATCH_CONCURRENCY } from "../../consts/commands";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../../libs/boundedSettledBatch";
import { getChatStateCache } from "../storage/stateStore";
import { isManagedAdminChat } from "./sweepEligibility";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { forgetUserBlocklistRemovals } from "./outbox";
import {
  cachedBlocklistEntry,
  confirmIdentityPolicyPersisted,
  prefetchIdentityPolicies,
  queueBlocklistDeletion,
  queueIdentityPolicyWrite,
} from "../identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../identityPolicy/temporaryAdBypass";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";

/**
 * 生成跨群处置的目标群 ID 列表：isAdminHere 为真时发起群排在最前，随后追加其余已启用 `/init` 且机器人为管理员的受管群。
 */
export function managedAdminChatIds(chatId: number, isAdminHere: boolean): number[] {
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getChatStateCache()) {
    if (adminChatId !== chatId && isManagedAdminChat(chatState)) targetChatIds.push(adminChatId);
  }
  return targetChatIds;
}

/** 单群处置结算结果。 */
export interface ManagedChatOutcome<T> {
  readonly chatId: number;
  readonly value: T;
}

/** runManagedChatBatch 的入参。 */
export interface RunManagedChatBatchParams<T> {
  /** 目标群 ID 列表。 */
  readonly chatIds: readonly number[];
  /** 异常日志中的动作描述。 */
  readonly action: string;
  /** 单群处置执行函数。 */
  readonly execute: (chatId: number) => Promise<T>;
  /** 单群抛出未预期异常时的回退返回值。 */
  readonly onUnexpectedFailure: T;
}

/** 按 MANAGED_CHAT_BATCH_CONCURRENCY 有界并发执行多群处置，按输入顺序返回各群结算结果。 */
export async function runManagedChatBatch<T>({
  chatIds,
  action,
  execute,
  onUnexpectedFailure,
}: RunManagedChatBatchParams<T>): Promise<readonly ManagedChatOutcome<T>[]> {
  const settlements: BoundedBatchResult<number, T>[] =
    await runBoundedSettledBatch<number, T>({
      items: chatIds,
      maxConcurrent: MANAGED_CHAT_BATCH_CONCURRENCY,
      execute: ({ item: targetChatId }: BoundedBatchExecution<number>): Promise<T> =>
        execute(targetChatId),
    });
  throwIfUpdateAborted();
  const outcomes: ManagedChatOutcome<T>[] = [];
  for (const settlement of settlements) {
    if (settlement.status === "rejected") {
      logger.error(
        `Unexpected error while running ${action} in chat ${settlement.item} ` +
        `(batch index ${settlement.index}):`,
        settlement.reason
      );
    }
    outcomes.push({
      chatId: settlement.item,
      value: settlement.status === "fulfilled" ? settlement.value : onUnexpectedFailure,
    });
  }
  return outcomes;
}

/** 同步判断指定用户或频道身份是否在黑名单缓存中（未命中按不在名单处理）。 */
export function isUserBlocked(userId: number): boolean {
  return cachedBlocklistEntry(userId) !== undefined;
}

/** 启动阶段校验配置的超级管理员不在黑名单中，违反时抛出致命错误。 */
export async function assertSuperAdminNotBlocked(
  superAdminUserId: number
): Promise<void> {
  if (!await prefetchIdentityPolicies([superAdminUserId])) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: blocklist_entries could not be read; ` +
      "refusing to start without confirming the super admin is absent from it."
    );
  }
  if (cachedBlocklistEntry(superAdminUserId) === undefined) return;
  throw new Error(
    `${IDENTITY_DATABASE_PATH}: blocklist_entries must not contain the configured ` +
    `super admin identity ${superAdminUserId}; expected the two sets to stay disjoint.`
  );
}

/** 将指定身份加入黑名单并清理其临时广告免检进度，参见 docs/cn/04-invariants.md；已存在时返回 false。 */
export function blockUser(
  userId: number,
  meta: Readonly<TelegramIdentityMetadata>
): boolean {
  if (isUserBlocked(userId)) return false;
  const blockedAt: string = formatLocalTime(Date.now());
  clearTemporaryAdBypassActivityOrThrow(userId);
  queueIdentityPolicyWrite("blocklist", userId, { blockedAt, meta });
  return true;
}

/** 等待指定身份当前未确认的黑名单变更落盘（retryUnacknowledged 为真时先补投未确认变更）。 */
export async function confirmBlocklistPersisted(
  userId: number,
  retryUnacknowledged: boolean
): Promise<boolean> {
  try {
    await confirmIdentityPolicyPersisted("blocklist", userId, retryUnacknowledged);
    return true;
  } catch (error: unknown) {
    logger.error("Blocklist entry was not persisted to disk:", error);
    return false;
  }
}

/** 从黑名单移除指定身份并同步裁剪待踢 outbox 中的关联任务；原本不在名单中时返回 false。 */
export function unblockUser(userId: number): boolean {
  if (cachedBlocklistEntry(userId) === undefined) return false;
  queueBlocklistDeletion(userId, (): void => forgetUserBlocklistRemovals(userId));
  return true;
}
