import { wedChats } from "../../cache/main/wed";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../consts/telegram";
import { WED_SESSION_CAPACITY, WED_SESSION_LIMIT } from "../../consts/wed";
import { deleteMessages } from "../../infra/telegram";
import { isChatUnreachable } from "../../libs/chatTeardown";
import { FifoMap } from "../../libs/fifoMap";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type { WedChat, WedMemberState, WedSession } from "../../types/wed";
import { getOrCreateWedMemberState } from "./persistence";

/**
 * 只由通过初始化网关的群交互创建；成员集合满额（STATE_MANAGED_CHAT_LIMIT）时
 * 拒绝新群，交互表与成员集合同界，不淘汰；每群会话表容量为 WED_SESSION_CAPACITY
 * （WED_SESSION_LIMIT 已送达上限 + WED_MAX_CONCURRENT 并发在途上限）。
 * @param chatId 目标群 ID。
 * @returns 群的 `/wed` 交互状态；成员集合满额无法新建时返回 undefined。
 */
export function getOrCreateWedChat(chatId: number): WedChat | undefined {
  let chat: WedChat | undefined = wedChats.get(chatId);
  if (chat !== undefined) return chat;
  const state: WedMemberState | undefined = getOrCreateWedMemberState(chatId);
  if (state === undefined) return undefined;
  chat = {
    controller: new AbortController(),
    members: state.members,
    sessions: new FifoMap<number, WedSession>(WED_SESSION_CAPACITY),
    departed: false,
  };
  wedChats.set(chatId, chat);
  return chat;
}

/**
 * 新结果送达或重抽失败换回原会话后，将会话表裁剪回 WED_SESSION_LIMIT 份已送达结果：
 * 按送达顺序从最早到最新扫描，跳过正在执行动作的忙碌会话，滑出最早的一份空闲结果并 abort 其 controller（不删群内消息）。
 * @param chat 目标群的 `/wed` 交互状态。
 */
export function trimWedSessions(chat: WedChat): void {
  let delivered: number = 0;
  let earliestIdle: WedSession | undefined;
  for (const session of chat.sessions.values()) {
    if (session.messageId === undefined) continue;
    delivered++;
    if (earliestIdle === undefined && !session.busy) earliestIdle = session;
  }
  if (delivered > WED_SESSION_LIMIT && earliestIdle !== undefined) {
    chat.sessions.delete(earliestIdle.actor.id);
    earliestIdle.controller.abort();
  }
}

/**
 * 群 teardown：同步取消排队任务与群内全部会话（正在执行动作的忙碌会话由其自身 `finally` 收尾）。
 * - **机器人已不可访问本群**（`isChatUnreachable` 为真）：置位 `departed` 并清空全部会话的 `messageId`；
 *   忙碌会话的 `finally`（含重抽替换下来的旧会话）见 `departed` 为真时不再发起删除请求。
 * - **机器人仍在群**：将当前空闲会话的结果消息按 `TELEGRAM_DELETE_MESSAGES_BATCH_MAX` 分批删除，整批成功后清空对应 `messageId`。
 * @param chatId 目标群 ID。
 * @param chat 目标群的 `/wed` 交互状态。
 * @param reason 清理触发原因。
 */
export async function teardownWedChat(
  chatId: number,
  chat: WedChat,
  reason: ChatTeardownReason
): Promise<void> {
  const idle: WedSession[] = [];
  const idleMessageIds: number[] = [];
  chat.controller.abort();
  const unreachable: boolean = isChatUnreachable(reason);
  if (unreachable) chat.departed = true;
  for (const session of chat.sessions.values()) {
    if (unreachable) {
      session.messageId = undefined;
    } else if (!session.busy && session.messageId !== undefined) {
      idle.push(session);
      idleMessageIds.push(session.messageId);
    }
    session.controller.abort();
  }
  for (let start: number = 0; start < idle.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
    const end: number = start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX;
    if (!await deleteMessages(chatId, idleMessageIds.slice(start, end))) continue;
    for (const session of idle.slice(start, end)) session.messageId = undefined;
  }
}
