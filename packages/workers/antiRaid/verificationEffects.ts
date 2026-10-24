import { workerAtmosphere } from "./atmosphere";
import { answerVerificationCallback } from "./verificationCallbacks";
import {
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} from "../../cache/workers/antiRaid/verification";
import { VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS } from "../../consts/antiRaid/verification";
import { logger } from "../../infra/logger";
import {
  deleteMessage,
  telegramApi,
} from "../../infra/telegram";
import { runBooleanTelegramAction } from "../../infra/telegram/actions/core";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import type { TelegramWorkerTemporaryMessageResult } from "../../types/telegramWorker";
import { verificationKey } from "../../libs/verificationKey";
import type { VerificationDispatcher } from "../../types/antiRaid/internal";
import type {
  VerificationEffect,
  VerificationState,
} from "../../types/states/verification";
import { fetchAdminIds } from "./adminCache";
import { retractJoinWindow } from "./lockdownJoinWindow";
import { runKickMemberEffect } from "./verificationEffects/kick";
import { retryTerminalAttempt } from "./verificationEffects/retry";
import {
  runExpelEffect,
  runRecheckInviterEffect,
} from "./verificationEffects/terminal";
import {
  sendReplyReminder,
  sendVerificationReminder,
} from "./verificationReminders";
import { trackAntiRaidTask } from "./taskTracker";
import { requestVerificationAttemptPermit } from "./verificationAttemptPermit";
import type { VerificationAttemptPermitResult } from
  "../../types/antiRaid/protocol";
import {
  isTerminalVerificationPhase,
  isTerminalVerificationState,
} from "../../states/verification/shared";
import { antiRaidDispatchAbort } from "../../cache/workers/antiRaid/tasks";

/** 向主线程申请入群验证终态执行许可的异步请求函数类型。 */
export type VerificationAttemptRequester = (
  key: string,
  generation: number,
  revision: number
) => Promise<VerificationAttemptPermitResult>;

/** 执行一次入群验证状态转移产出的副作用所需的参数。 */
export interface RunVerificationEffectsParams {
  /** 群组 ID。 */
  chatId: number;
  /** 目标成员 ID。 */
  userId: number;
  /** 状态转移产出的副作用序列。 */
  effects: readonly VerificationEffect[];
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
  /** 向主线程申请终态尝试许可的请求函数，默认使用双工桥实现。 */
  requestTerminalAttempt?: VerificationAttemptRequester;
}

/**
 * 判断副作用列表中是否包含需要申请进程级终态执行许可的动作。
 * @param effects 状态转移产出的副作用序列。
 * @returns 含有 `kickMember`、`recheckInviter`、`expel` 或 `expelFlood` 时返回 true，否则返回 false。
 */
function includesTerminalAttempt(effects: readonly VerificationEffect[]): boolean {
  for (const effect of effects) {
    if (
      effect.kind === "kickMember" ||
      effect.kind === "recheckInviter" ||
      effect.kind === "expel" ||
      effect.kind === "expelFlood"
    ) {
      return true;
    }
  }
  return false;
}

/** 发起许可申请那一刻的执行 token。 */
interface TerminalAttemptToken {
  /** 发起申请时的验证状态对象引用。 */
  readonly transitionState: VerificationState | undefined;
  /** 发起申请时的 Worker 代际编号。 */
  readonly generation: number;
  /** 发起申请时的验证记录修订号。 */
  readonly revision: number;
}

/**
 * 申请许可时的执行 token 在 await 之后是否仍是当前这一份：状态对象、代际、revision 都没换，也没在停机。
 * @param key 待验证键（`chatId:userId`）。
 * @param token 申请许可前捕获的执行 token。
 * @returns 状态对象、代际与修订号均未变化且 Worker 未进入停机取消时返回 true，否则返回 false。
 */
function isSameTransition(key: string, token: TerminalAttemptToken): boolean {
  return verificationEntries.get(key)?.state === token.transitionState &&
    verificationGeneration.current === token.generation &&
    verificationRevisions.get(key)?.revision === token.revision &&
    antiRaidDispatchAbort.current?.signal.aborted !== true;
}

/** acquireTerminalAttempt 的入参。 */
interface AcquireTerminalAttemptParams {
  /** 群组 ID。 */
  readonly chatId: number;
  /** 目标成员 ID。 */
  readonly userId: number;
  /** 待验证键（`chatId:userId`）。 */
  readonly key: string;
  /** 触发本批副作用时的验证状态引用。 */
  readonly transitionState: VerificationState | undefined;
  /** 验证状态机派发函数。 */
  readonly dispatchVerification: VerificationDispatcher;
  /** 向主线程申请终态尝试许可的请求函数。 */
  readonly requestTerminalAttempt: VerificationAttemptRequester;
}

/** 一次已取得的终态许可：第几次尝试与申请时的 revision。 */
interface GrantedTerminalAttempt {
  /** 本进程内该验证键的第几次终态执行尝试。 */
  readonly attempt: number;
  /** 申请许可时的验证记录修订号。 */
  readonly revision: number;
}

/**
 * 为本批终态副作用向主线程申请一次许可。token 已换代、申请抛错或未获批时返回 null，本批副作用
 * 一律不执行；抛错与未获批在 token 仍精确匹配时判耗尽，交给延后闩锁。
 * @param params 终态许可申请参数。
 * @returns 获批时返回尝试次数与修订号；未获批、抛错或状态已换代时返回 null。
 */
async function acquireTerminalAttempt({
  chatId,
  userId,
  key,
  transitionState,
  dispatchVerification,
  requestTerminalAttempt,
}: AcquireTerminalAttemptParams): Promise<GrantedTerminalAttempt | null> {
  const generation: number = verificationGeneration.current;
  const revision: number | undefined = verificationRevisions.get(key)?.revision;
  if (generation <= 0 || revision === undefined) return null;
  const token: TerminalAttemptToken = { transitionState, generation, revision };
  let permit: VerificationAttemptPermitResult;
  try {
    permit = await requestTerminalAttempt(key, generation, revision);
  } catch (error: unknown) {
    if (!isSameTransition(key, token)) return null;
    logger.error(`Failed to acquire verification terminal attempt permit for ${key}:`, error);
    // 当前许可无法确认时卸载运行态，沿既有延后边界保留磁盘快照；
    // 主线程接管延后闩锁，完整进程重启后再恢复，不消耗本地 Telegram 重试计数。
    dispatchVerification(chatId, userId, { type: "terminalAttemptBudgetExhausted" });
    return null;
  }
  if (!isSameTransition(key, token)) return null;
  if (permit.status !== "granted") {
    // stale 只对仍精确匹配的当前 token 收口，不能触碰已经换代或更新的记录。
    dispatchVerification(chatId, userId, { type: "terminalAttemptBudgetExhausted" });
    return null;
  }
  return { attempt: permit.attempt, revision };
}

/**
 * 欢迎语按变体取本进程风格的文案。
 * @param effect 发送欢迎语副作用描述符。
 * @returns 渲染后的欢迎提示文案。
 */
function welcomeTextFor(effect: Extract<VerificationEffect, { kind: "sendWelcome" }>): string {
  const texts: ReturnType<typeof workerAtmosphere>["NOTICE_TEXTS"] = workerAtmosphere().NOTICE_TEXTS;
  if (effect.variant === "channelComment") return texts.verificationCommentExempt(effect.targetLabel);
  if (effect.variant === "vouchedBot") return texts.verificationBotApproved(effect.fromLabel, effect.targetLabel);
  if (effect.variant === "approved") return texts.verificationMemberApproved(effect.fromLabel, effect.targetLabel);
  return texts.verificationSelfPassed(effect.fromLabel);
}

/**
 * 按序执行一次转移返回的副作用；同一列表内先删后踢再通知的顺序有意义。
 * @param params 验证副作用执行参数。
 */
export async function runVerificationEffects({
  chatId,
  userId,
  effects,
  dispatchVerification,
  requestTerminalAttempt = requestVerificationAttemptPermit,
}: RunVerificationEffectsParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  // 整批 effect 共享同一个执行 token；前置 await 后不得捕获替换后的新状态。
  const transitionState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  let granted: GrantedTerminalAttempt | null = null;
  if (includesTerminalAttempt(effects)) {
    granted = await acquireTerminalAttempt({
      chatId,
      userId,
      key,
      transitionState,
      dispatchVerification,
      requestTerminalAttempt,
    });
    if (granted === null) return;
  }
  try {
    for (const effect of effects) {
      switch (effect.kind) {
        case "deleteMessage":
          await deleteMessage(chatId, effect.messageId, telegramApi);
          break;
        case "kickMember":
          await runKickMemberEffect({
            chatId,
            userId,
            transitionState,
            dispatchVerification,
          });
          break;
        case "deleteReminders":
          if (effect.reminderMessageId !== undefined) {
            await deleteMessage(chatId, effect.reminderMessageId, telegramApi);
          }
          if (effect.replyReminderMessageId !== undefined) {
            await deleteMessage(chatId, effect.replyReminderMessageId, telegramApi);
          }
          break;
        case "expel":
        case "expelFlood":
          await runExpelEffect({
            chatId,
            userId,
            effect,
            dispatchVerification,
          });
          break;
        case "recheckInviter":
          await runRecheckInviterEffect({
            chatId,
            userId,
            effect,
            dispatchVerification,
          });
          break;
        case "sendReminder":
          sendVerificationReminder({
            chatId,
            userId,
            label: effect.label,
            isBot: effect.isBot,
            dispatchVerification,
          });
          break;
        case "sendReplyReminder":
          sendReplyReminder({
            chatId,
            userId,
            label: effect.label,
            isBot: effect.isBot,
            targetMessageId: effect.targetMessageId,
            dispatchVerification,
          });
          break;
        case "sendWelcome": {
          const welcomeText: string = welcomeTextFor(effect);
          await runBooleanTelegramAction(
            "send message",
            (signal?: AbortSignal): Promise<TelegramWorkerTemporaryMessageResult | undefined> => sendTemporaryMessageFromMain({
              purpose: "notice",
              chatId,
              text: welcomeText,
              replyToMessageId: effect.anchorMessageId,
              signal,
            })
          );
          break;
        }
        case "answerCallback":
          await answerVerificationCallback({ callbackQueryId: effect.callbackQueryId, reply: effect.reply });
          break;
        case "startAdminCheck":
          startAdminCheck({
            chatId,
            userId,
            actorId: effect.actorId,
            dispatchVerification,
          });
          break;
        case "retractJoinCount":
          retractJoinWindow(chatId, effect.joinedAt);
          break;
        case "logUncancelableKickExemption":
          // Worker 经 error 日志向主线程中继，供人工纠正误踢。
          logger.error(
            `The kick request for member ${effect.label} (chat ${chatId}, user ${userId}) had already been sent or completed ` +
            "when exemption proof (admin identity) arrived; it cannot be undone automatically — " +
            "an admin may need to manually re-invite them if this was a false positive."
          );
          break;
      }
    }
  } catch (error: unknown) {
    // 取得许可的这批终态动作中途 reject：条目仍是同一终态对象时复位执行门并按退避重试
    // （kickPending 投递 kickRetry，其余终态投递 terminalPersisted），再把错误交给
    // dispatchVerification 记日志。
    if (granted !== null && isTerminalVerificationState(transitionState)) {
      retryTerminalAttempt({ chatId, userId, state: transitionState, dispatchVerification });
    }
    throw error;
  }
  // 本进程最后一次许可用完仍停在终态时，只有本轮没有发布新 revision 才就地判耗尽。
  // 本轮已发布新 revision（置位 successNoticeSent、removalConfirmed 等持久化标志，或
  // 终态换代）时，由该 revision 的落盘回执继续驱动：成功战报据此结算，仍需执行的
  // 终态再次申请许可时由主线程判 exhausted。
  if (
    granted !== null &&
    granted.attempt >= VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS &&
    verificationRevisions.get(key)?.revision === granted.revision &&
    isTerminalVerificationPhase(verificationEntries.get(key)?.state?.kind)
  ) {
    dispatchVerification(chatId, userId, {
      type: "terminalAttemptBudgetExhausted",
    });
  }
}

/** 异步核查拉人者管理员身份所需的参数。 */
interface StartAdminCheckParams {
  /** 群组 ID。 */
  chatId: number;
  /** 被拉入群的待验证成员 ID。 */
  userId: number;
  /** 执行拉人操作的用户 ID。 */
  actorId: number;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/**
 * 异步核查拉人者管理员身份；只向仍是同一对象的 pending 状态回投结果。
 * @param params 管理员邀请豁免异步核查参数。
 */
function startAdminCheck({
  chatId,
  userId,
  actorId,
  dispatchVerification,
}: StartAdminCheckParams): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured?.kind !== "pending") return;
  void trackAntiRaidTask({
    task: fetchAdminIds(chatId)
      .then((adminIds: Set<number>): void => {
        if (!adminIds.has(actorId)) return;
        if (verificationEntries.get(key)?.state === captured) {
          dispatchVerification(chatId, userId, { type: "adminCheckResolved" });
        }
      })
      .catch((error: unknown): void => {
        logger.error(
          `Error fetching chat admins for admin-invite exemption in chat ${chatId}:`,
          error
        );
      }),
  });
}
