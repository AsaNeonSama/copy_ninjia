/**
 * Anti-Raid Worker 入站消息到纯验证状态机事件的翻译层。
 * 这里预计算管理员、lockdown 与评论区线索，状态转移仍由 dispatcher 统一执行。
 */
import { workerAtmosphere } from "./atmosphere";
import { lockdownEntries } from "../../cache/workers/antiRaid/lockdown";
import {
  deferredVerificationRecords,
  threadCommentConfirmations,
  verificationEntries,
} from "../../cache/workers/antiRaid/verification";
import { formatUserLabel } from "../../users/userLabel";
import { verificationKey } from "../../libs/verificationKey";
import { THREAD_COMMENT_CONFIRMATION_MAX } from "../../consts/antiRaid/cache";
import type {
  AntiRaidMember,
  NewMemberMessage,
  TrackedChatMessage,
} from "../../types/antiRaid/protocol";
import type {
  ThreadCommentConfirmation,
  VerificationDispatcher,
} from "../../types/antiRaid/internal";
import { joinCreatesNewRecord } from "../../states/verification";
import { admitVerificationJoin } from "./verificationAdmission";
import type {
  JoinEvent,
  VerificationState,
} from "../../types/states/verification";
import { freshAdminIds } from "./adminCache";
import { trackAntiRaidTask } from "./taskTracker";
import {
  cachedChatHasLinkedChannel,
  fetchChatHasLinkedChannel,
} from "./linkedChannel";
import { recordJoin } from "./lockdownRuntime";
import {
  rememberRecentComment,
  takeRecentComment,
} from "./recentComments";

/**
 * 按当前群风格格式化新入群成员的展示名称。
 * @param member 入群成员简要信息。
 * @returns 格式化后的成员展示标签。
 */
function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({
    id: member.id,
    username: member.username,
    first_name: member.first_name,
  }, workerAtmosphere());
}

/**
 * 仅处理主线程已通过守卫开关的入群；容量拒收先于刷群计数与豁免线索消费。
 * @param message 主线程发来的新成员入群消息。
 * @param dispatchVerification 验证状态机派发函数。
 */
export function handleJoinEvent(
  message: NewMemberMessage,
  dispatchVerification: VerificationDispatcher
): void {
  const { chatId, member }: NewMemberMessage = message;
  const key: string = verificationKey(chatId, member.id);
  // 本进程预算已耗尽的终态只能由下一次完整进程启动恢复；同 key 再入群不能
  // 创建新状态、重置主线程预算或重新武装 Telegram 副作用。
  if (deferredVerificationRecords.has(key)) return;
  if (!admitVerificationJoin(key)) return;
  const entryState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const actorId: number | undefined = message.actorId;
  const invitedByOther: boolean =
    actorId !== undefined && actorId !== member.id;
  const adminIds: Set<number> | undefined = freshAdminIds(chatId);
  const event: JoinEvent = {
    type: "join",
    memberId: member.id,
    label: memberLabel(member),
    isBot: member.isBot === true,
    announcementMessageId: message.announcementMessageId,
    actorId,
    identityExempt: message.exempt === true,
    // 拉人者豁免只认同步命中的新鲜非匿名管理员缓存；缓存冷时由状态机的
    // startAdminCheck 异步补查（私密模式期间不补查，见 states/verification/join.ts）。
    actorSyncExempt: invitedByOther &&
      actorId !== undefined &&
      adminIds?.has(actorId) === true,
    adminCacheFresh: adminIds !== undefined,
    lockdownActive: lockdownEntries.has(chatId),
    recentComment: takeRecentComment(chatId, member.id),
    now: Date.now(),
  };
  if (joinCreatesNewRecord(entryState, event)) {
    // joinedAt 与滑动窗口使用同一个时间戳，retractJoinWindow 才能按值精确撤销。
    recordJoin(chatId, event.now);
    // 这一次 recordJoin 可能同步建立 lockdown 占位，事件刷新 lockdownActive 后再派发。
    event.lockdownActive = lockdownEntries.has(chatId);
  }
  dispatchVerification(chatId, member.id, event);

  // 把早到的楼中楼确认绑定到本次 join 的精确状态对象。
  const currentState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const confirmation: ThreadCommentConfirmation | undefined =
    threadCommentConfirmations.get(key);
  if (
    confirmation !== undefined &&
    currentState !== undefined &&
    !confirmation.boundToJoin
  ) {
    confirmation.expectedState = currentState;
    confirmation.boundToJoin = true;
  }
}

/** 处理已确认属于频道评论区的留言所需的参数。 */
interface ConfirmedCommentParams {
  /** 主线程发来的受跟踪群消息。 */
  message: TrackedChatMessage;
  /** 消息观察毫秒时间戳。 */
  observedAt: number;
  /** 验证状态机派发函数。 */
  dispatchVerification: VerificationDispatcher;
}

/** 异步确认楼中楼评论是否属于关联频道所需的参数。 */
interface ConfirmThreadCommentParams extends ConfirmedCommentParams {
  /** 待验证键（`chatId:userId`）。 */
  key: string;
  /** 异步确认前若该条消息恰好触发刷屏踢出终态，确认后是否允许豁免撤销该终态。 */
  allowFloodTerminalExemption: boolean;
}

/**
 * 处理已确认属于频道评论区的留言：尚无验证状态记录时暂存以备后到 join 关联，已有记录时直接派发评论区发言事件。
 * @param params 已确认频道评论处理参数。
 */
function rememberOrDispatchConfirmedComment({
  message,
  observedAt,
  dispatchVerification,
}: ConfirmedCommentParams): void {
  const key: string = verificationKey(message.chatId, message.userId);
  if (!verificationEntries.has(key)) {
    rememberRecentComment({
      chatId: message.chatId,
      userId: message.userId,
      messageId: message.messageId,
      observedAt,
    });
    return;
  }
  dispatchVerification(message.chatId, message.userId, {
    type: "trackedMessage",
    messageId: message.messageId,
    inCommentThread: true,
    now: observedAt,
  });
}

/**
 * 在关联频道缓存冷缺失时登记楼中楼回复确认 owner，并异步拉取本群是否绑定关联频道；确认为真且状态对象未换代时补发豁免。
 * @param params 楼中楼评论异步确认参数。
 */
function confirmThreadComment({
  message,
  observedAt,
  dispatchVerification,
  key,
  allowFloodTerminalExemption,
}: ConfirmThreadCommentParams): void {
  const expectedState: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const existing: ThreadCommentConfirmation | undefined =
    threadCommentConfirmations.get(key);
  if (existing !== undefined) {
    const sameStateToken: boolean = existing.expectedState === expectedState;
    existing.messageId = message.messageId;
    existing.observedAt = observedAt;
    existing.expectedState = expectedState;
    existing.boundToJoin = expectedState !== undefined;
    existing.allowFloodTerminalExemption =
      allowFloodTerminalExemption ||
      (
        sameStateToken &&
        existing.allowFloodTerminalExemption
      );
    return;
  }
  // 满载时直接拒绝新 owner，不淘汰已有项；该消息已按普通消息 fail closed。
  if (
    threadCommentConfirmations.size >=
    THREAD_COMMENT_CONFIRMATION_MAX
  ) {
    return;
  }
  const confirmation: ThreadCommentConfirmation = {
    messageId: message.messageId,
    observedAt,
    expectedState,
    boundToJoin: expectedState !== undefined,
    allowFloodTerminalExemption,
  };
  threadCommentConfirmations.set(key, confirmation);

  void trackAntiRaidTask({
    task: fetchChatHasLinkedChannel(message.chatId).then((hasLinked: boolean | undefined): void => {
      // 群停管、adopt 或同键新 owner 会替换/删除 token；迟到结果在写 recent comment
      // 或回投状态机之前止步。
      if (threadCommentConfirmations.get(key) !== confirmation) return;
      threadCommentConfirmations.delete(key);
      if (hasLinked !== true) return;

      const currentState: VerificationState | undefined =
        verificationEntries.get(key)?.state;
      if (currentState !== confirmation.expectedState) return;
      if (currentState === undefined && confirmation.boundToJoin) return;
      if (currentState === undefined) {
        rememberRecentComment({
          chatId: message.chatId,
          userId: message.userId,
          messageId: confirmation.messageId,
          observedAt: confirmation.observedAt,
        });
        return;
      }
      dispatchVerification(message.chatId, message.userId, {
        type: "confirmedThreadComment",
        messageId: confirmation.messageId,
        now: confirmation.observedAt,
        allowFloodTerminalExemption:
          confirmation.allowFloodTerminalExemption,
      });
    }),
  });
}

/**
 * 处理一条受入群验证跟踪的群消息：区分直属频道评论、楼中楼回复与普通消息并派发给验证状态机。
 * @param message 主线程发来的受跟踪群消息。
 * @param dispatchVerification 验证状态机派发函数。
 */
export function handleTrackedMessageEvent(
  message: TrackedChatMessage,
  dispatchVerification: VerificationDispatcher
): void {
  const observedAt: number = Date.now();
  if (message.repliesToChannelPost === true) {
    rememberOrDispatchConfirmedComment({
      message,
      observedAt,
      dispatchVerification,
    });
    return;
  }

  if (message.isThreadReply === true) {
    const key: string = verificationKey(message.chatId, message.userId);
    const cachedHasLinked: boolean | undefined =
      cachedChatHasLinkedChannel(message.chatId);
    if (cachedHasLinked === true) {
      rememberOrDispatchConfirmedComment({
        message,
        observedAt,
        dispatchVerification,
      });
      return;
    }
    // 冷缓存先 fail closed；确认有关联频道后再以状态对象同一性升级为豁免。
    const previousState: VerificationState | undefined =
      verificationEntries.get(key)?.state;
    dispatchVerification(message.chatId, message.userId, {
      type: "trackedMessage",
      messageId: message.messageId,
      inCommentThread: false,
      now: observedAt,
    });
    if (cachedHasLinked === undefined) {
      const currentState: VerificationState | undefined =
        verificationEntries.get(key)?.state;
      confirmThreadComment({
        message,
        observedAt,
        dispatchVerification,
        key,
        allowFloodTerminalExemption:
          previousState?.kind === "pending" &&
          currentState?.kind === "expelling" &&
          currentState.reason === "flood",
      });
    }
    return;
  }

  dispatchVerification(message.chatId, message.userId, {
    type: "trackedMessage",
    messageId: message.messageId,
    inCommentThread: false,
    now: observedAt,
  });
}
