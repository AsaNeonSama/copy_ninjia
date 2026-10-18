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
 * 群关闭同步取消排队及会话；忙碌项由自身 finally 清理。
 *
 * 机器人已无法访问本群（isChatUnreachable：被移出或群已不存在）时结果一条也删不掉：作废全部
 * 消息 id 并置位 `departed`，忙碌项的 finally（含重抽时被替换、已不在会话表里的旧结果）随之
 * 不再发删除请求。其余起因把此刻空闲的结果按 deleteMessages 的单次上限分批删除，整批成功才作废
 * 这一批的消息 id。
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
