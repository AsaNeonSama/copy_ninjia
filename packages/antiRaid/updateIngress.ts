import { chatAtmosphere } from "../infra/atmosphere";
import type { Context } from "grammy";
import type {
  CallbackQuery,
  Chat,
  ChatMemberUpdated,
  Message,
  User,
} from "grammy/types";
import { logger } from "../infra/logger";
import { recordJoinLog } from "../infra/joinLog";
import { answerCallbackQuery } from "../infra/telegram/actions";
import {
  cachedBotAdminStatus,
  resolveBotAdminStatus,
  markBotAdminObserved,
} from "../infra/botAdmin";
import { VERIFY_APPROVE_CALLBACK_PREFIX, VERIFY_SELF_CALLBACK_PREFIX } from "../consts/antiRaid/verification";

import { isAdminStatus, isPresentMember } from "../libs/chatMember";
import { hasUserMessageContent } from "../users/messageContent";
import { isActiveVerificationUser } from "../cache/main/antiRaid/verificationMirror";
import { adCandidatePostRejected } from "../cache/main/antiRaid/proxy";
import { getChatState } from "../infra/storage/stateStore";
import { updateNow } from "../infra/updateContext";
import { adDetectionSenderId, buildAdCandidate } from "./adCandidate";
import { visibleSenderChat } from "../users/visibleSender";
import { observeChatKind } from "./chatKind";
import {
  claimBlockedJoiner,
  deleteBlockedSenderChatMessage,
} from "./blocklistGuard";
import { buildFloodCandidate } from "./floodControl";
import {
  isInviterExemptAdmin,
  pickMember,
} from "./memberFacts";
import { postAntiRaidDurably } from "./durableDelivery";
import { parseUserIdArgument } from "../libs/telegramId";
import { postAntiRaid } from "./workerBridge/controller";
import { recordEligibleTemporaryAdBypassActivity } from "./temporaryAdBypass";
import type {
  AdCandidateMessage,
  AdDetectionMessageContext,
} from "../types/antiRaid/adDetect";
import type {
  AntiRaidWorkerMessage,
  FloodCandidateMessage,
} from "../types/antiRaid/protocol";
import type { ChatState } from "../types/chatState";
import { TELEGRAM_DATE_UNIT_MS } from "../consts/telegram";

/**
 * 处理 `chat_member` 更新：记录群类型与管理员身份观测，同步邀请者豁免缓存，
 * 并将入群/离群事件与黑名单秒踢批次经 durable 边界投递给 Worker。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  observeChatKind(update.chat);
  const user: User = update.new_chat_member.user;
  if (user.id === ctx.me.id) return;

  await markBotAdminObserved(chatId);

  const joinGuardEnabled: boolean = getChatState(chatId).isAntiRaidEnabled === true;

  const wasActive: boolean = isPresentMember(update.old_chat_member);
  const isActive: boolean = isPresentMember(update.new_chat_member);

  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  const wasInviterExempt: boolean =
    isInviterExemptAdmin(update.old_chat_member);
  const isInviterExempt: boolean =
    isInviterExemptAdmin(update.new_chat_member);
  const messages: AntiRaidWorkerMessage[] = [];
  if (wasInviterExempt !== isInviterExempt) {
    messages.push({
      type: "adminsChanged",
      chatId,
      userId: user.id,
      isInviterExempt,
    });
  }

  const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
  if (!wasActive && isActive) {
    if (!recordJoinLog({
      chatId,
      userId: user.id,
      joinedAt: update.date * TELEGRAM_DATE_UNIT_MS,
    })) {
      throw new Error(
        `Join log persistence refused the event for chat ${chatId}, user ${user.id}.`
      );
    }
    const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
      ? {
        type: "join",
        chatId,
        member: pickMember(user),
        exempt: isAdmin,
        actorId: update.from.id,
      }
      : undefined;
    if (!claimBlockedJoiner({
      chatId,
      userId: user.id,
      messages,
      replacedJoin: joinMessage,
      replacedJoins,
      joinGuardEnabled,
    }) && joinMessage !== undefined) {
      messages.push(joinMessage);
    }
  } else if (wasActive && !isActive && joinGuardEnabled) {
    messages.push({ type: "left", chatId, userId: user.id });
  }
  if (messages.length > 0) {
    await postAntiRaidDurably(messages, replacedJoins);
  }
}

/**
 * 群消息的入群守卫入口（位于 app/updatePreamble.ts 命令处理之前）：拦截黑名单频道消息、
 * 吞并 `new_chat_members` 入群公告，并向 Worker 投递入群/离群服务消息、广告候选、刷屏候选与待验证成员发言。
 * @returns 若消息已被接管或属于入群公告、调用方应跳过后续处理时返回 true，否则返回 false。
 */
export function handleAntiRaidMessageIngress(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  if (message.chat?.type === "private") return false;

  observeChatKind(message.chat);

  const knownAdmin: boolean | undefined = cachedBotAdminStatus(message.chat.id);
  if (knownAdmin !== undefined) {
    return knownAdmin
      ? ingestAdminChatMessage(message, botId)
      : isSwallowedJoinAnnouncement(message);
  }
  return resolveBotAdminStatus(message.chat.id).then(
    (isAdmin: boolean): boolean | Promise<boolean> => isAdmin
      ? ingestAdminChatMessage(message, botId)
      : isSwallowedJoinAnnouncement(message)
  );
}

/** 判断消息是否为需吞并的 `new_chat_members` 入群服务消息。 */
function isSwallowedJoinAnnouncement(message: Message): boolean {
  return !!(message.new_chat_members && message.new_chat_members.length > 0);
}

/**
 * 记录广告候选投递的边沿状态变化日志（见 adCandidatePostRejected）。
 */
function noteAdCandidatePost(chatId: number, posted: boolean): void {
  if (posted) {
    if (adCandidatePostRejected.current) {
      adCandidatePostRejected.current = false;
      logger.log("Anti-Raid Worker accepts ad detection candidates again.");
    }
    return;
  }
  if (adCandidatePostRejected.current) return;
  adCandidatePostRejected.current = true;
  logger.error(
    `Anti-Raid Worker rejected an ad detection candidate from chat ${chatId}; ` +
    "further rejections are not logged until a candidate is accepted again."
  );
}

/**
 * 在已确证机器人具备群管理员身份后，先执行黑名单频道消息门禁，未命中时进入 ingestAdmittedMessage。
 */
function ingestAdminChatMessage(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  const blocked: boolean | Promise<boolean> =
    deleteBlockedSenderChatMessage(message);
  if (typeof blocked !== "boolean") {
    return blocked.then((claimed: boolean): boolean | Promise<boolean> =>
      claimed ? true : ingestAdmittedMessage(message, botId));
  }
  return blocked ? true : ingestAdmittedMessage(message, botId);
}

/**
 * 处理通过黑名单门禁的群消息：分发入群/离群服务消息、广告候选、刷屏计数与验证/评论线索。
 */
function ingestAdmittedMessage(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  const chatState: Readonly<ChatState> = getChatState(message.chat.id);
  if (
    message.new_chat_members &&
    message.new_chat_members.length > 0
  ) {
    const joinGuardEnabled: boolean = chatState.isAntiRaidEnabled === true;
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
    for (const member of message.new_chat_members) {
      if (member.id === botId) continue;
      const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
        ? {
          type: "join",
          chatId: message.chat.id,
          member: pickMember(member),
          announcementMessageId: message.message_id,
          actorId: message.from?.id,
        }
        : undefined;
      if (claimBlockedJoiner({
        chatId: message.chat.id,
        userId: member.id,
        messages,
        replacedJoin: joinMessage,
        replacedJoins,
        announcementMessageId: message.message_id,
        joinGuardEnabled,
      })) {
        continue;
      }
      if (joinMessage !== undefined) messages.push(joinMessage);
    }
    if (messages.length > 0) {
      return postAntiRaidDurably(messages, replacedJoins).then((): boolean => true);
    }
    return true;
  }

  if (message.left_chat_member) {
    if (chatState.isAntiRaidEnabled === true) {
      return postAntiRaidDurably([{
        type: "left",
        chatId: message.chat.id,
        userId: message.left_chat_member.id,
      }]).then((): boolean => false);
    }
    return false;
  }

  let adCandidate: AdCandidateMessage | undefined;
  if (chatState.isAdDetectEnabled === true) {
    const senderChat: Chat | undefined = visibleSenderChat(message);
    const adSenderId: number | undefined = adDetectionSenderId(message, botId, senderChat);
    if (adSenderId !== undefined) {
      const adContext: AdDetectionMessageContext = {
        message,
        botId,
        now: updateNow(),
        senderId: adSenderId,
        senderChat,
      };
      if (hasUserMessageContent(message)) {
        recordEligibleTemporaryAdBypassActivity(adContext);
      }
      adCandidate = buildAdCandidate(adContext);
    }
  }
  if (adCandidate !== undefined) noteAdCandidatePost(message.chat.id, postAntiRaid(adCandidate));

  const now: number = updateNow();
  const floodCandidate: FloodCandidateMessage | undefined =
    message.chat.type === "supergroup" && chatState.isFloodControlEnabled === true
      ? buildFloodCandidate({ message, botId, now, chatState })
      : undefined;
  if (floodCandidate !== undefined) {
    postAntiRaid(floodCandidate);
  }

  const userId: number | undefined = message.from?.id;
  const isCommentThreadReply: boolean =
    message.message_thread_id !== undefined &&
    message.is_topic_message !== true;
  const mayPrecedeJoinInCommentThread: boolean =
    message.reply_to_message?.is_automatic_forward === true ||
    isCommentThreadReply;
  if (userId === undefined) return false;
  const senderPending: boolean = isActiveVerificationUser(message.chat.id, userId);
  if (
    !(senderPending || mayPrecedeJoinInCommentThread) ||
    chatState.isAntiRaidEnabled !== true
  ) {
    return false;
  }
  const workerMessage: AntiRaidWorkerMessage = {
    type: "message",
    chatId: message.chat.id,
    userId,
    messageId: message.message_id,
    repliesToChannelPost:
      message.reply_to_message?.is_automatic_forward === true,
    isThreadReply: isCommentThreadReply,
  };
  if (senderPending) return postAntiRaidDurably([workerMessage]).then((): boolean => false);
  postAntiRaid(workerMessage);
  return false;
}

/**
 * 处理入群验证按钮回调（callback_query）：按前缀解析本人验证或管理员代点「通过」，
 * 校验目标用户 ID 后经 durable 边界投递给 Worker。
 */
export async function handleVerificationCallback(
  ctx: Context
): Promise<void> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (!query || data === undefined) return;
  let action: "self" | "approve";
  let prefixLength: number;
  if (data.startsWith(VERIFY_SELF_CALLBACK_PREFIX)) {
    action = "self";
    prefixLength = VERIFY_SELF_CALLBACK_PREFIX.length;
  } else if (data.startsWith(VERIFY_APPROVE_CALLBACK_PREFIX)) {
    action = "approve";
    prefixLength = VERIFY_APPROVE_CALLBACK_PREFIX.length;
  } else {
    return;
  }

  const callbackChatId: number | undefined = query.message?.chat.id;
  if (
    callbackChatId !== undefined &&
    getChatState(callbackChatId).isAntiRaidEnabled !== true
  ) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: chatAtmosphere().VERIFICATION_GUARD_DISABLED_CALLBACK_TEXT,
      showAlert: true,
    });
    return;
  }

  // 使用严格十进制整数解析校验外部 callback_data 的目标用户 ID（见 libs/telegramId.ts 的 parseUserIdArgument）。
  const targetUserId: number | undefined = parseUserIdArgument(data.slice(prefixLength));
  if (targetUserId === undefined) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: chatAtmosphere().VERIFICATION_INVALID_CALLBACK_TEXT,
      showAlert: true,
    });
    return;
  }

  await postAntiRaidDurably([{
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId,
    action,
    from: pickMember(query.from),
  }]);
}
