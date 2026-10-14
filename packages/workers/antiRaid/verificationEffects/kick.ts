import { verificationEntries } from "../../../cache/workers/antiRaid/verification";
import { logger } from "../../../infra/logger";
import {
  kickChatMemberWithOutcome,
  probeChatMembership,
  telegramApi,
} from "../../../infra/telegram";
import { verificationKey } from "../../../libs/verificationKey";
import type {
  VerificationDispatcher,
  VerificationEntry,
} from "../../../types/antiRaid/internal";
import type { VerificationState } from "../../../types/states/verification";
import type { KickChatMemberOutcome } from "../../../infra/telegram";
import { botCanRestrictIn } from "../botPermissions";
import { resolveChatIsSupergroup } from "../chatKind";
import { retryTerminalAttempt } from "./retry";

interface RunKickMemberEffectParams {
  chatId: number;
  userId: number;
  transitionState: VerificationState | undefined;
  dispatchVerification: VerificationDispatcher;
}

/**
 * 执行私密模式踢人。transitionState 是整批 effect 捕获的执行 token，任何豁免、
 * 停管或新一代记录都会让不可逆调用在同步复核处失效。
 */
export async function runKickMemberEffect({
  chatId,
  userId,
  transitionState,
  dispatchVerification,
}: RunKickMemberEffectParams): Promise<void> {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  if (
    transitionState?.kind !== "kickPending" ||
    entry?.state !== transitionState
  ) return;
  // 确证缺少限制成员权限时只做成员探测：已离群即结算，否则进入退避重试。
  if (botCanRestrictIn(chatId) === false) {
    const presentWithoutPermission: boolean | undefined =
      await probeChatMembership(chatId, userId, telegramApi);
    if (verificationEntries.get(key)?.state !== transitionState) return;
    if (presentWithoutPermission === false) {
      dispatchVerification(chatId, userId, {
        type: "kickSettled",
        now: Date.now(),
      });
      return;
    }
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} was not attempted: the bot is confirmed to lack ` +
      "can_restrict_members there; retaining the pending action and backing off until the permission returns."
    );
    retryTerminalAttempt({ chatId, userId, state: transitionState, dispatchVerification });
    return;
  }
  const isSupergroup: boolean | undefined =
    await resolveChatIsSupergroup(chatId);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (isSupergroup === undefined) {
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} could not resolve whether the chat is a group or supergroup; ` +
      "retaining the pending action rather than guessing a removal API."
    );
    retryTerminalAttempt({ chatId, userId, state: transitionState, dispatchVerification });
    return;
  }
  // 踢人前先探测成员是否仍在群内（超级群「只踢不封」约束见 docs/cn/04-invariants.md）。
  const memberPresentBeforeKick: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (memberPresentBeforeKick === false) {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }
  if (memberPresentBeforeKick === undefined) {
    logger.error(
      `Lockdown kick for user ${userId} in chat ${chatId} could not confirm the member is still present; ` +
      "retaining the pending action rather than issuing a removal that would lift a ban placed in the meantime."
    );
    retryTerminalAttempt({ chatId, userId, state: transitionState, dispatchVerification });
    return;
  }

  dispatchVerification(chatId, userId, { type: "kickRequestSent", attemptState: transitionState });
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId,
    userId,
    isSupergroup,
  });
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (outcome === "kicked" || outcome === "absent") {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }

  // 请求失败后重新允许权威豁免替换 token，再用成员探测消除响应丢失的不确定性。
  dispatchVerification(chatId, userId, { type: "kickRequestFailed", attemptState: transitionState });
  const memberPresent: boolean | undefined =
    await probeChatMembership(chatId, userId, telegramApi);
  if (verificationEntries.get(key)?.state !== transitionState) return;
  if (memberPresent === false) {
    dispatchVerification(chatId, userId, {
      type: "kickSettled",
      now: Date.now(),
    });
    return;
  }
  logger.error(
    outcome === "forbidden"
      ? `Lockdown kick for user ${userId} in chat ${chatId} was forbidden by Telegram permissions or member status; retaining the pending action for retry.`
      : `Lockdown kick for user ${userId} in chat ${chatId} did not settle; retaining the pending action for retry.`
  );
  retryTerminalAttempt({ chatId, userId, state: transitionState, dispatchVerification });
}
