import {
  verificationCallbackChecks,
  verificationCallbackOverloadLogged,
  verificationCallbackReplies,
} from "../../cache/workers/antiRaid/verificationCallbacks";
import { verificationEntries, verificationGeneration } from "../../cache/workers/antiRaid/verification";
import { VERIFICATION_CALLBACK_CHECK_MAX, VERIFICATION_CALLBACK_REPLY_MAX } from "../../consts/antiRaid/verification";
import { logger } from "../../infra/logger";
import { answerCallbackQuery } from "../../infra/telegram";
import { verificationKey } from "../../libs/verificationKey";
import { formatUserLabel } from "../../users/userLabel";
import type { VerificationDispatcher, VerificationEntry } from "../../types/antiRaid/internal";
import type { VerifyCallbackMessage } from "../../types/antiRaid/protocol";
import type { VerificationEffect } from "../../types/states/verification";
import type { AtmosphereTexts } from "../../types/atmosphere";
import { workerAtmosphere } from "./atmosphere";
import { isChatAdmin } from "./adminCache";
import { trackAntiRaidTask } from "./taskTracker";

type VerificationCallbackReply = Extract<VerificationEffect, { kind: "answerCallback" }>["reply"];

export interface AnswerVerificationCallbackOptions {
  /** Telegram 回调查询 ID。 */
  readonly callbackQueryId: string;
  /** 验证状态机决定的回调应答类型；缺省时仅静默消除加载状态。 */
  readonly reply?: VerificationCallbackReply;
}

/**
 * 将验证回调应答类型映射为当前气氛下的提示文案。
 * @param reply 验证回调应答类型；无提示文案时为 undefined。
 * @returns 对应的提示文案；`reply` 为 undefined 时返回 undefined。
 */
function verificationCallbackText(
  reply: VerificationCallbackReply | undefined
): string | undefined {
  if (reply === undefined) return undefined;
  const atmosphere: AtmosphereTexts = workerAtmosphere();
  switch (reply) {
    case "ok": return atmosphere.NOTICE_TEXTS.verificationCallbackPassed;
    case "invalid": return atmosphere.NOTICE_TEXTS.verificationCallbackExpired;
    case "useSelfButton":
      return atmosphere.NOTICE_TEXTS.verificationUseSelfButton(
        atmosphere.VERIFICATION_SELF_BUTTON_TEXT,
        atmosphere.VERIFICATION_APPROVE_BUTTON_TEXT
      );
    case "notApprover": return atmosphere.NOTICE_TEXTS.verificationAdminOnly;
    case "approverUnknown": return atmosphere.NOTICE_TEXTS.verificationAdminUnknown;
    case "notYourButton": return atmosphere.NOTICE_TEXTS.verificationOtherUser;
    default: {
      const unhandledReply: never = reply;
      throw new Error(`Unsupported verification callback reply: ${String(unhandledReply)}`);
    }
  }
}

/**
 * 验证按钮的唯一回执边界；文案沿用状态机结果，发送和过载回执共用在途硬顶。
 * 满载时不创建请求或等待者；已受理的请求保持排空责任，遵循 docs/cn/04-invariants.md。
 * @param options 回调应答选项。
 * @returns 已受理应答请求的 Promise；在途应答已满载时返回 undefined。
 */
export function answerVerificationCallback({
  callbackQueryId,
  reply,
}: AnswerVerificationCallbackOptions): Promise<void> | undefined {
  if (verificationCallbackReplies.current >= VERIFICATION_CALLBACK_REPLY_MAX) {
    if (!verificationCallbackOverloadLogged.current) {
      verificationCallbackOverloadLogged.current = true;
      logger.warn("Join verification callback replies reached their in-flight limit.");
    }
    return undefined;
  }
  const text: string | undefined = verificationCallbackText(reply);
  verificationCallbackReplies.current++;
  return answerCallbackQuery({
    callbackQueryId,
    text,
    showAlert: reply !== undefined && reply !== "ok",
  }).catch((error: unknown): void => {
    logger.error("Error answering join verification callback:", error);
  }).finally((): void => { verificationCallbackReplies.current--; });
}

/**
 * 本人点击同步转移；代点查询有界受理，回投前同时核验 Worker 代际与验证实例。
 * 普通 pending 字段原地更新保持实例有效；leave/rejoin、adopt、停管或 stop 使旧结果失效。
 * @param message 主线程转发的验证内联按钮点击消息。
 * @param dispatchVerification 验证状态机派发函数。
 */
export function handleVerificationCallbackEvent(
  message: VerifyCallbackMessage,
  dispatchVerification: VerificationDispatcher
): void {
  const chatId: number | undefined = message.chatId;
  if (chatId === undefined) {
    const task: Promise<void> | undefined = answerVerificationCallback({ callbackQueryId: message.callbackQueryId });
    if (task !== undefined) void trackAntiRaidTask({ task });
    return;
  }
  const targetUserId: number = message.targetUserId;
  const key: string = verificationKey(chatId, targetUserId);
  const expectedEntry: VerificationEntry | undefined = verificationEntries.get(key);
  const generation: number = verificationGeneration.current;
  const isSelf: boolean = message.from.id === targetUserId;
  const needsAdminCheck: boolean = message.action === "approve" && !isSelf && expectedEntry?.state.kind === "pending";
  if (needsAdminCheck && verificationCallbackChecks.current >= VERIFICATION_CALLBACK_CHECK_MAX) {
    const task: Promise<void> | undefined = answerVerificationCallback({
      callbackQueryId: message.callbackQueryId, reply: "approverUnknown",
    });
    if (task !== undefined) void trackAntiRaidTask({ task });
    return;
  }
  const fromLabel: string = formatUserLabel({
    id: message.from.id,
    username: message.from.username,
    first_name: message.from.first_name,
  }, workerAtmosphere());
  if (!needsAdminCheck) {
    dispatchVerification(chatId, targetUserId, {
      type: "callback", callbackQueryId: message.callbackQueryId,
      action: message.action, isSelf, fromCanApprove: false, fromLabel,
    });
    return;
  }
  verificationCallbackChecks.current++;
  void trackAntiRaidTask({
    task: isChatAdmin(chatId, message.from.id, "verification approver")
      .then((isAdmin: boolean | undefined): void | Promise<void> => {
        if (generation !== verificationGeneration.current || verificationEntries.get(key) !== expectedEntry) {
          return answerVerificationCallback({ callbackQueryId: message.callbackQueryId, reply: "invalid" });
        }
        dispatchVerification(chatId, targetUserId, {
          type: "callback", callbackQueryId: message.callbackQueryId,
          action: "approve", isSelf: false, fromCanApprove: isAdmin, fromLabel,
        });
      })
      .finally((): void => { verificationCallbackChecks.current--; }),
  });
}
