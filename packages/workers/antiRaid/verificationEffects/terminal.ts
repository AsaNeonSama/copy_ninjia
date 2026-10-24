import { workerAtmosphere } from "../atmosphere";
import type { TelegramWorkerTemporaryMessageResult } from "../../../types/telegramWorker";
import { sendTemporaryMessageFromMain } from "../../../infra/telegram/workerClient";
import { runTelegramAction } from "../../../infra/telegram/actions/core";
import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  deleteMessageWithOutcome,
  kickChatMemberWithOutcome,
  probeChatMembership,
  telegramApi,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import { isMessageDeletionSettled } from "../../../libs/messageDeletion";
import type { VerificationDispatcher, VerificationEntry } from "../../../types/antiRaid/internal";
import type {
  CheckingInviterState,
  ExpelSnapshot,
  ExpellingState,
  VerificationEffect,
  VerificationState,
} from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";
import type { DeleteMessageOutcome } from "../../../types/telegram";
import { isChatAdmin } from "../adminCache";
import { botCanDeleteIn, botCanRestrictIn } from "../botPermissions";
import { resolveChatIsSupergroup } from "../chatKind";
import { retryTerminalAttempt } from "./retry";
import { expelNoticeText } from "./expelNotice";
import { VERIFICATION_CLEANUP_SETTLED } from "../../../consts/antiRaid/verification";
import type { ExpelRemovalOutcome, VerificationCleanupResult } from "../../../types/antiRaid/verification";

interface RunRecheckInviterEffectParams {
  /** 群组 ID。 */
  chatId: number;
  /** 待验证成员 ID。 */
  userId: number;
  /** 拉人者终核副作用描述符。 */
  effect: Extract<VerificationEffect, { kind: "recheckInviter" }>;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/**
 * 只为仍匹配快照的 checkingInviter 终态执行拉人者终核。
 * @param params 拉人者终核执行参数。
 */
export async function runRecheckInviterEffect({
  chatId,
  userId,
  effect,
  dispatchVerification,
}: RunRecheckInviterEffectParams): Promise<void> {
  const expectedState: VerificationState | undefined =
    verificationEntries.get(verificationKey(chatId, userId))?.state;
  if (
    expectedState?.kind !== "checkingInviter" ||
    expectedState.snapshot !== effect.snapshot
  ) return;
  await recheckInviterThenSettle({
    chatId,
    userId,
    inviterId: effect.inviterId,
    expectedState,
    dispatchVerification,
  });
}

interface RunExpelEffectParams {
  /** 群组 ID。 */
  chatId: number;
  /** 待踢出成员 ID。 */
  userId: number;
  /** 超时或刷屏踢出副作用描述符。 */
  effect: Extract<VerificationEffect, { kind: "expel" | "expelFlood" }>;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/**
 * 执行仍匹配快照的处置终态，并为未结算动作安排有上限的指数退避。
 * @param params 踢出处置终态执行参数。
 */
export async function runExpelEffect({
  chatId,
  userId,
  effect,
  dispatchVerification,
}: RunExpelEffectParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  const expectedState: VerificationState | undefined = entry?.state;
  const reason: "timeout" | "flood" =
    effect.kind === "expelFlood" ? "flood" : "timeout";
  if (
    entry === undefined ||
    expectedState?.kind !== "expelling" ||
    expectedState.reason !== reason ||
    expectedState.snapshot !== effect.snapshot
  ) return;
  // 确证缺少限制成员权限、尚未确认踢出，且失败提示与验证消息清理均已完成时，每轮重试仅探测成员是否已离群；
  // 已确认踢出（removalConfirmed）时交给 expelMember 只探测一次，离群即补发成功战报。
  const permissionBlocked: boolean = botCanRestrictIn(chatId) === false;
  const removalConfirmed: boolean = expectedState.removalConfirmed === true;
  if (
    permissionBlocked &&
    !removalConfirmed &&
    expectedState.failureNoticeSent === true &&
    entry.cleanupSettled === true
  ) {
    const removal: ExpelRemovalOutcome = await probeBlockedMember(
      chatId,
      userId,
      (): boolean => verificationEntries.get(key)?.state === expectedState
    );
    if (removal === "stale") return;
    if (removal !== "absent") {
      retryTerminalAttempt({ chatId, userId, state: expectedState, dispatchVerification });
      return;
    }
    dispatchVerification(chatId, userId, { type: "expelSettled" });
    return;
  }
  if (permissionBlocked && !removalConfirmed) {
    logger.error(
      `Verification expel for user ${userId} in chat ${chatId} cannot kick: the bot is confirmed to lack ` +
      "can_restrict_members there. Cleaning up the bot's own verification messages and notifying the chat once, then " +
      "backing off with only a membership probe per retry until the member leaves or the permission returns."
    );
  }
  const settled: boolean = await expelMember({
    chatId,
    userId,
    snapshot: effect.snapshot,
    reason,
    canRestrict: !permissionBlocked,
    expectedState,
    dispatchVerification,
  });
  if (settled && verificationEntries.get(key)?.state === expectedState) {
    dispatchVerification(chatId, userId, { type: "expelSettled" });
    return;
  }
  if (
    verificationEntries.get(key)?.state !== expectedState ||
    expectedState.successNoticeSent === true
  ) return;

  // 成功播报已发送时等待落盘回执；只有未结算处置才进入本地指数退避。
  retryTerminalAttempt({ chatId, userId, state: expectedState, dispatchVerification });
}

interface RecheckInviterThenSettleParams {
  /** 群组 ID。 */
  chatId: number;
  /** 待验证成员 ID。 */
  userId: number;
  /** 拉人者用户 ID。 */
  inviterId: number;
  /** 发起终核时持有的 `checkingInviter` 状态对象。 */
  expectedState: CheckingInviterState;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/**
 * 超时踢人前核对拉人者身份；未知时保留终态并按既有执行预算退避。
 * @param params 拉人者终核结算参数。
 */
async function recheckInviterThenSettle({
  chatId,
  userId,
  inviterId,
  expectedState,
  dispatchVerification,
}: RecheckInviterThenSettleParams): Promise<void> {
  const inviterIsAdmin: boolean | undefined = await isChatAdmin(chatId, inviterId, "verification inviter");
  if (verificationEntries.get(verificationKey(chatId, userId))?.state !== expectedState) return;
  if (inviterIsAdmin === undefined) {
    retryTerminalAttempt({ chatId, userId, state: expectedState, dispatchVerification });
    return;
  }
  dispatchVerification(chatId, userId, { type: "timeoutInviterVerdict", inviterIsAdmin });
}

interface ExpelMemberParams {
  /** 群组 ID。 */
  chatId: number;
  /** 待踢出成员 ID。 */
  userId: number;
  /** 踢出终态冻结的待验证快照。 */
  snapshot: ExpelSnapshot;
  /** 踢出原因（验证超时或待验证期刷屏）。 */
  reason: "timeout" | "flood";
  /**
   * 确证没有限制成员权限时为 false：只做成员探测、不发踢人请求（见 probeBlockedMember），
   * 其余（清理机器人自己的验证消息、战报措辞、诊断名额）全部照旧；成员仍在群里或查询
   * 失败时结局按「没踢动」结算。
   */
  canRestrict: boolean;
  /** 发起处置时持有的 `expelling` 状态对象。 */
  expectedState: ExpellingState;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/**
 * 跨落盘重放的终态在踢人前重新确认成员仍在群里。查询失败不等于不在群，
 * 也不足以授权破坏性操作；每个 await 后都用状态对象同一性拒绝迟到结果。
 * @param chatId 群组 ID。
 * @param userId 待踢出成员 ID。
 * @param isCurrent 状态对象同一性复核闭包。
 * @returns 本轮踢人尝试的结局。
 */
async function kickPresentMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const isSupergroup: boolean | undefined =
    await resolveChatIsSupergroup(chatId);
  if (!isCurrent()) return "stale";
  if (isSupergroup === undefined) return "kindUnknown";
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (present === false) return "absent";
  if (present === undefined) return "unconfirmed";
  if (!isCurrent()) return "stale";
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId,
    isSupergroup,
  });
  if (outcome === "kicked") return "kicked";
  if (outcome === "absent") return "absent";
  return "failed";
}

/**
 * 确证没有限制成员权限时只探测成员、不发踢人请求：已离群为 absent，在群或查询失败为
 * failed（与请求被拒的结局一致），探测期间状态被替换为 stale。
 * @param chatId 群组 ID。
 * @param userId 待探测成员 ID。
 * @param isCurrent 状态对象同一性复核闭包。
 * @returns 探测结局（`absent`、`failed` 或 `stale`）。
 */
async function probeBlockedMember(
  chatId: number,
  userId: number,
  isCurrent: () => boolean
): Promise<ExpelRemovalOutcome> {
  const present: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (!isCurrent()) return "stale";
  return present === false ? "absent" : "failed";
}

interface DeleteVerificationMessagesOptions {
  /** 群组 ID。 */
  readonly chatId: number;
  /** 待踢出成员 ID。 */
  readonly userId: number;
  /** 踢出终态冻结的待验证快照。 */
  readonly snapshot: ExpelSnapshot;
  /** 状态对象同一性检查；每次删除前调用，拒绝替换后的迟到处理。 */
  readonly isCurrent: () => boolean;
}

/**
 * 删除机器人/Telegram 制造的验证消息（入群公告、提醒、回复提醒，去重），不删除成员自己的发言。
 * 确证没有删除权限时不发请求、整批记为未删；有未删的消息时按是否被拒绝记一条错误日志。
 * 删除途中状态被替换时返回 null。
 * @param options 验证消息清理选项。
 * @returns 清理统计结果；删除途中状态被替换时返回 null。
 */
async function deleteVerificationMessages({
  chatId,
  userId,
  snapshot,
  isCurrent,
}: DeleteVerificationMessagesOptions): Promise<VerificationCleanupResult | null> {
  const messageIds: number[] = [];
  for (const messageId of [
    snapshot.announcementMessageId,
    snapshot.reminderMessageId,
    snapshot.replyReminderMessageId,
  ]) {
    if (messageId !== undefined && !messageIds.includes(messageId)) {
      messageIds.push(messageId);
    }
  }
  let missed: number = 0;
  let permissionDenied: boolean = false;
  if (messageIds.length > 0 && botCanDeleteIn(chatId) === false) {
    missed = messageIds.length;
    permissionDenied = true;
  } else {
    for (const messageId of messageIds) {
      if (!isCurrent()) return null;
      const outcome: DeleteMessageOutcome =
        await deleteMessageWithOutcome(chatId, messageId, telegramApi);
      if (isMessageDeletionSettled(outcome)) continue;
      missed++;
      if (outcome === "forbidden") permissionDenied = true;
    }
  }
  if (missed > 0) {
    logger.error(
      `Verification expel could not delete ${missed} of ${messageIds.length} ` +
      `verification-owned message(s) for user ${userId} in chat ${chatId}: ` +
      (permissionDenied
        ? "Telegram denied the deletion, so the bot most likely lacks can_delete_messages."
        : "the deletions failed without a permission error, so this is most likely transient.")
    );
  }
  return { total: messageIds.length, missed, permissionDenied };
}

/**
 * 清理机器人验证痕迹并按现查结果踢出，成功播报先写入新 revision 再收尾。
 * @param params 踢出与清理执行参数。
 * @returns 可直接派发 `expelSettled` 结束终态时返回 true；需等待落盘回执、状态已换代或需退避重试时返回 false。
 */
async function expelMember({
  chatId,
  userId,
  snapshot,
  reason,
  canRestrict,
  expectedState,
  dispatchVerification,
}: ExpelMemberParams): Promise<boolean> {
  const key: string = verificationKey(chatId, userId);
  const initialEntry: VerificationEntry | undefined = verificationEntries.get(key);
  if (initialEntry?.state !== expectedState) return false;
  const stillCurrent = (): boolean => verificationEntries.get(key)?.state === expectedState;
  let removalOutcome: ExpelRemovalOutcome = "failed";
  if (reason === "flood") {
    removalOutcome = canRestrict
      ? await kickPresentMember(chatId, userId, stillCurrent)
      : await probeBlockedMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  const cleanup: VerificationCleanupResult | null = initialEntry.cleanupSettled
    ? VERIFICATION_CLEANUP_SETTLED
    : await deleteVerificationMessages({ chatId, userId, snapshot, isCurrent: stillCurrent });
  if (cleanup === null) return false;
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (entry?.state !== expectedState) return false;
  // 只在真的一条不剩时置位；欠着账就留给下一轮重试（见 VerificationEntry.cleanupSettled）。
  if (cleanup.missed === 0) entry.cleanupSettled = true;
  if (reason === "timeout") {
    removalOutcome = canRestrict
      ? await kickPresentMember(chatId, userId, stillCurrent)
      : await probeBlockedMember(chatId, userId, stillCurrent);
    if (removalOutcome === "stale") return false;
  }
  // 已不在群内时：若上一轮已由机器人踢出但未完成播报（removalConfirmed），继续补发播报；否则静默结算。
  const kicked: boolean = removalOutcome === "kicked" ||
    (removalOutcome === "absent" && expectedState.removalConfirmed === true);
  if (removalOutcome === "absent" && !kicked) return stillCurrent();
  if (!stillCurrent()) return false;

  const unconfirmed: boolean = removalOutcome === "unconfirmed" || removalOutcome === "kindUnknown";
  const shouldSendNotice: boolean = kicked
    ? expectedState.successNoticeSent !== true
    : unconfirmed
      ? expectedState.unconfirmedNoticeSent !== true
      : expectedState.failureNoticeSent !== true;
  const noticeMessageId: number | undefined = shouldSendNotice
    ? await runTelegramAction({
      action: "send message",
      execute: (signal?: AbortSignal): Promise<TelegramWorkerTemporaryMessageResult | undefined> => sendTemporaryMessageFromMain({
        purpose: "notice",
        chatId,
        text: expelNoticeText({
          texts: workerAtmosphere().NOTICE_TEXTS,
          reason,
          removalOutcome,
          kicked,
          cleanup,
          label: snapshot.label,
          isBot: snapshot.isBot,
        }),
        signal,
      }),
      map: (result: TelegramWorkerTemporaryMessageResult | undefined): number | undefined =>
        result !== undefined && "messageId" in result ? result.messageId : undefined,
      fallback: undefined,
    })
    : undefined;
  if (!stillCurrent()) return false;
  if (noticeMessageId !== undefined) {
    dispatchVerification(chatId, userId, {
      type: "expelNoticeSent",
      notice: kicked ? "success" : unconfirmed ? "unconfirmed" : "failure",
    });
    if (kicked) return false;
  } else if (kicked && shouldSendNotice) {
    dispatchVerification(chatId, userId, { type: "removalConfirmed" });
    return false;
  }
  return kicked;
}
