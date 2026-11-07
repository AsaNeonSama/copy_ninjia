/**
 * 黑名单身份的跨群封禁与解封：`/block enable|disable` 与 Mini App 黑名单增删共用同一个逐群执行单元，
 * 按 MANAGED_CHAT_BATCH_CONCURRENCY 有界并发；目标群清单由 ./membership.ts 的 managedAdminChatIds 给出。
 */

import { MANAGED_CHAT_BATCH_CONCURRENCY } from "../../consts/commands";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../../libs/boundedSettledBatch";
import { botCanRestrictMembersIn } from "../botAdmin";
import { logger } from "../logger";
import {
  banChatMember,
  banChatSenderChat,
  unbanChatMemberIfBanned,
  unbanChatSenderChat,
} from "../telegram";
import { throwIfUpdateAborted } from "../updateContext";
import { requestBlocklistResweep } from "./sweepRetryState";

/** 单群处置结算结果。 */
interface ManagedChatOutcome<T> {
  /** 目标群 ID。 */
  readonly chatId: number;
  /** 单群处置执行返回值或异常回退值。 */
  readonly value: T;
}

/** runManagedChatBatch 的入参。 */
interface RunManagedChatBatchParams<T> {
  /** 目标群 ID 列表。 */
  readonly chatIds: readonly number[];
  /** 异常日志中的动作描述。 */
  readonly action: string;
  /** 单群处置执行函数。 */
  readonly execute: (chatId: number) => Promise<T>;
  /** 单群抛出未预期异常时的回退返回值。 */
  readonly onUnexpectedFailure: T;
}

/**
 * 按 MANAGED_CHAT_BATCH_CONCURRENCY 有界并发执行多群处置，按输入顺序返回各群结算结果。
 *
 * @param params 多群有界并发处置的目标群列表、执行函数与异常回退配置。
 * @returns 与输入群顺序一致的各群处置结算结果只读数组。
 */
async function runManagedChatBatch<T>({
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

/** `banBlockedIdentityInManagedChats` 与 `liftBlockedIdentityBanInManagedChats` 的入参。 */
export interface ManagedChatIdentityBanParams {
  /** 目标受管群 ID 列表，按此顺序执行与结算。 */
  readonly chatIds: readonly number[];
  /** 被封禁或解封的用户或频道身份 ID。 */
  readonly identityId: number;
  /** 身份是否为频道；频道走 sender_chat 封禁接口。 */
  readonly isChannel: boolean;
}

/**
 * 在给定受管群里逐群封禁一个黑名单身份（`/block enable` 与 Mini App 拉黑共用）。
 *
 * 快照已确证缺「限制与封禁成员」的群不发请求，计为失败；快照未知时照常发，由 Telegram 裁决
 * （见 infra/botAdmin.ts 的 botCanRestrictMembersIn）。用户走 banChatMember，频道走
 * banChatSenderChat。失败的群经 requestBlocklistResweep 重新登记补扫，权限恢复后由下一次
 * 管理员身份观测重扫（见 infra/blocklist/sweep.ts）。
 * @param params 目标群、身份 ID 与是否频道。
 * @returns 封禁成功的群数。
 */
export async function banBlockedIdentityInManagedChats({
  chatIds,
  identityId,
  isChannel,
}: ManagedChatIdentityBanParams): Promise<number> {
  const outcomes: readonly ManagedChatOutcome<boolean>[] = await runManagedChatBatch<boolean>({
    chatIds,
    action: `ban blocked identity ${identityId}`,
    onUnexpectedFailure: false,
    execute: (chatId: number): Promise<boolean> => {
      if (botCanRestrictMembersIn(chatId) === false) return Promise.resolve(false);
      return isChannel ? banChatSenderChat(chatId, identityId) : banChatMember(chatId, identityId);
    },
  });
  let bannedCount: number = 0;
  for (const outcome of outcomes) {
    if (outcome.value) bannedCount++;
    else requestBlocklistResweep(outcome.chatId);
  }
  return bannedCount;
}

/**
 * 在给定受管群里逐群解除一个身份的封禁（`/block disable` 与 Mini App 移出黑名单共用）。
 *
 * 缺封禁权限的群口径同 banBlockedIdentityInManagedChats，不发请求、计为失败，失败不登记补扫。
 * 用户只解除已有封禁（`only_if_banned`），不把仍在群里的成员移出；频道解除 sender_chat 封禁。
 * @param params 目标群、身份 ID 与是否频道。
 * @returns 解封成功的群数。
 */
export async function liftBlockedIdentityBanInManagedChats({
  chatIds,
  identityId,
  isChannel,
}: ManagedChatIdentityBanParams): Promise<number> {
  const outcomes: readonly ManagedChatOutcome<boolean>[] = await runManagedChatBatch<boolean>({
    chatIds,
    action: `lift the ban on identity ${identityId}`,
    onUnexpectedFailure: false,
    execute: (chatId: number): Promise<boolean> => {
      if (botCanRestrictMembersIn(chatId) === false) return Promise.resolve(false);
      return isChannel
        ? unbanChatSenderChat(chatId, identityId)
        : unbanChatMemberIfBanned(chatId, identityId);
    },
  });
  let unbannedCount: number = 0;
  for (const outcome of outcomes) {
    if (outcome.value) unbannedCount++;
  }
  return unbannedCount;
}
