import type { AtmosphereTexts } from "../../types/atmosphere";
import { workerAtmosphere } from "./atmosphere";
import { logger } from "../../infra/logger";
import {
  deleteMessage,
  sendMessage,
  telegramApi,
} from "../../infra/telegram";
import { VERIFICATION_REMINDER_RETRY_INITIAL_MS, VERIFICATION_REMINDER_RETRY_MAX_MS, VERIFICATION_TIMEOUT_MS, VERIFY_APPROVE_CALLBACK_PREFIX, VERIFY_SELF_CALLBACK_PREFIX } from "../../consts/antiRaid/verification";

import { reminderDeliveries, verificationEntries } from "../../cache/workers/antiRaid/verification";
import { formatMinSec } from "../../libs/time";
import { cappedExponentialMs } from "../../libs/backoff";
import { verificationKey } from "../../libs/verificationKey";
import type {
  ReminderDelivery,
  ReminderKind,
  VerificationDispatcher,
} from "../../types/antiRaid/internal";
import type { PendingState, VerificationState } from "../../types/states/verification";
import { trackAntiRaidTask } from "./taskTracker";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";

/**
 * 待验证提醒的唯一投递 owner：发送失败时在验证期限内退避重试，状态换代
 * 后取消旧 owner，并删除已经迟到落地的 Telegram 消息。
 */

export function cancelReminderDelivery(key: string): void {
  const delivery: ReminderDelivery | undefined = reminderDeliveries.get(key);
  if (!delivery) return;
  if (delivery.timer !== undefined) clearTimeout(delivery.timer);
  reminderDeliveries.delete(key);
}

export function clearReminderDeliveries(): void {
  for (const delivery of reminderDeliveries.values()) {
    if (delivery.timer !== undefined) clearTimeout(delivery.timer);
  }
  reminderDeliveries.clear();
}

/** 构造验证提醒内联键盘：真人展示本人验证与管理员通过按钮，机器人仅展示管理员通过按钮。 */
function buildVerificationKeyboard(userId: number, isBot: boolean, atmosphere: AtmosphereTexts): InlineKeyboardMarkup {
  const approveButton: InlineKeyboardButton = {
    text: atmosphere.VERIFICATION_APPROVE_BUTTON_TEXT,
    callback_data: `${VERIFY_APPROVE_CALLBACK_PREFIX}${userId}`,
  };
  if (isBot) return { inline_keyboard: [[approveButton]] };
  return {
    inline_keyboard: [[
      {
        text: atmosphere.VERIFICATION_SELF_BUTTON_TEXT,
        callback_data: `${VERIFY_SELF_CALLBACK_PREFIX}${userId}`,
      },
      approveButton,
    ]],
  };
}

function scheduleReminderRetry(
  delivery: ReminderDelivery,
  dispatchVerification: VerificationDispatcher
): void {
  const remainingMs: number = delivery.expectedState.expiresAt - Date.now();
  if (remainingMs <= 0) return; // verifyTimeout 会延长期限并重新唤醒这个 owner。
  const backoffMs: number = cappedExponentialMs(
    VERIFICATION_REMINDER_RETRY_INITIAL_MS,
    delivery.attempts,
    VERIFICATION_REMINDER_RETRY_MAX_MS
  );
  delivery.attempts += 1;
  delivery.timer = setTimeout(
    (): void => {
      delivery.timer = undefined;
      attemptReminderDelivery(delivery, dispatchVerification);
    },
    Math.max(1, Math.min(backoffMs, remainingMs))
  );
  delivery.timer.unref();
}

/**
 * 发起一次验证提醒发送尝试。调用方保证 `delivery` 是 `reminderDeliveries` 中的当前
 * owner、当前未在途（`!delivery.inFlight`）且对应验证状态尚未换代（状态换代时由运行态
 * 同步取消旧 owner，见 docs/cn/04-invariants.md「验证提醒发送与成员发言保护」）。
 */
function attemptReminderDelivery(
  delivery: ReminderDelivery,
  dispatchVerification: VerificationDispatcher
): void {
  delivery.inFlight = true;
  const atmosphere: AtmosphereTexts = workerAtmosphere();
  const verifyKeyboard: InlineKeyboardMarkup = buildVerificationKeyboard(
    delivery.userId,
    delivery.expectedState.isBot,
    atmosphere
  );
  // 每次发送尝试都按当前群风格渲染，重试队列不保存已经选定语气的正文。
  const text: string = delivery.kind === "reply"
    ? atmosphere.NOTICE_TEXTS.verificationReplyReminder(delivery.label, formatMinSec(VERIFICATION_TIMEOUT_MS), atmosphere.VERIFICATION_SELF_BUTTON_TEXT)
    : delivery.isBot
      ? atmosphere.NOTICE_TEXTS.verificationBotReminder(delivery.label, formatMinSec(VERIFICATION_TIMEOUT_MS), atmosphere.VERIFICATION_APPROVE_BUTTON_TEXT)
      : atmosphere.NOTICE_TEXTS.verificationMemberReminder({ label: delivery.label, timeout: formatMinSec(VERIFICATION_TIMEOUT_MS), selfButton: atmosphere.VERIFICATION_SELF_BUTTON_TEXT, approveButton: atmosphere.VERIFICATION_APPROVE_BUTTON_TEXT });
  const task: Promise<void> = (async (): Promise<void> => {
    let reminderMessageId: number | undefined;
    try {
      reminderMessageId = await sendMessage({
        chatId: delivery.chatId,
        text,
        replyToMessageId: delivery.replyToMessageId,
        keyboard: verifyKeyboard,
      });
    } catch (error: unknown) {
      logger.error(`Error sending ${delivery.kind} join verification reminder:`, error);
    }
    delivery.inFlight = false;

    // 回复式提醒已取代原 owner，或状态换代时已同步取消旧 owner：成功落地的迟到消息
    // 必须自删，失败结果则不能为已取消的 owner 再安排重试。
    if (reminderDeliveries.get(delivery.key) !== delivery) {
      if (reminderMessageId !== undefined) {
        void trackAntiRaidTask({
          task: deleteMessage(delivery.chatId, reminderMessageId, telegramApi),
        });
      }
      return;
    }

    if (reminderMessageId === undefined) {
      scheduleReminderRetry(delivery, dispatchVerification);
      return;
    }

    reminderDeliveries.delete(delivery.key);
    dispatchVerification(delivery.chatId, delivery.userId, {
      type: "reminderLanded",
      reminderKind: delivery.kind,
      messageId: reminderMessageId,
      now: Date.now(),
    });
  })();
  void trackAntiRaidTask({ task });
}

interface SendReminderMessageParams {
  chatId: number;
  userId: number;
  reminderKind: ReminderKind;
  label: string;
  isBot: boolean;
  replyToMessageId: number | undefined;
  dispatchVerification: VerificationDispatcher;
}

function sendReminderMessage({
  chatId,
  userId,
  reminderKind,
  label,
  isBot,
  replyToMessageId,
  dispatchVerification,
}: SendReminderMessageParams): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured?.kind !== "pending") return;
  const existing: ReminderDelivery | undefined = reminderDeliveries.get(key);
  if (existing?.expectedState === captured && existing.kind === reminderKind) {
    if (!existing.inFlight && existing.timer === undefined) {
      attemptReminderDelivery(existing, dispatchVerification);
    }
    return;
  }
  cancelReminderDelivery(key);
  const delivery: ReminderDelivery = {
    key,
    chatId,
    userId,
    kind: reminderKind,
    label,
    isBot,
    replyToMessageId,
    expectedState: captured,
    attempts: 0,
    timer: undefined,
    inFlight: false,
  };
  reminderDeliveries.set(key, delivery);
  attemptReminderDelivery(delivery, dispatchVerification);
}

interface SendVerificationReminderParams {
  chatId: number;
  userId: number;
  label: string;
  isBot: boolean;
  dispatchVerification: VerificationDispatcher;
}

/** 发送原始独立提醒；真人自己点本人验证，机器人只能由管理员点「通过」作保。 */
export function sendVerificationReminder({
  chatId,
  userId,
  label,
  isBot,
  dispatchVerification,
}: SendVerificationReminderParams): void {
  sendReminderMessage({
    chatId,
    userId,
    reminderKind: "original",
    label,
    isBot,
    replyToMessageId: undefined,
    dispatchVerification,
  });
}

interface SendReplyReminderParams {
  chatId: number;
  userId: number;
  label: string;
  targetMessageId: number;
  dispatchVerification: VerificationDispatcher;
}

/** 把提醒回复到待验证成员刚发出的普通群消息，确保 TA 收到通知。 */
export function sendReplyReminder({
  chatId,
  userId,
  label,
  targetMessageId,
  dispatchVerification,
}: SendReplyReminderParams): void {
  sendReminderMessage({
    chatId,
    userId,
    reminderKind: "reply",
    label,
    isBot: false,
    replyToMessageId: targetMessageId,
    dispatchVerification,
  });
}

interface EnsurePendingReminderParams {
  chatId: number;
  userId: number;
  state: PendingState;
  dispatchVerification: VerificationDispatcher;
}

/** 恢复快照或 timeout 续窗时，按当前状态选择唯一有效的提醒形态。 */
export function ensurePendingReminder({
  chatId,
  userId,
  state,
  dispatchVerification,
}: EnsurePendingReminderParams): void {
  if (
    state.reminderMessageId !== undefined ||
    state.replyReminderMessageId !== undefined
  ) return;
  if (state.replyReminderRequested && state.welcomeAnchorMessageId !== undefined) {
    sendReplyReminder({
      chatId,
      userId,
      label: state.label,
      targetMessageId: state.welcomeAnchorMessageId,
      dispatchVerification,
    });
  } else {
    sendVerificationReminder({
      chatId,
      userId,
      label: state.label,
      isBot: state.isBot,
      dispatchVerification,
    });
  }
}
