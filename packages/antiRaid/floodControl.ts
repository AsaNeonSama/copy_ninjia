/**
 * 刷屏禁言主线程入口：按群开关、群类型、发送者身份与白名单豁免构建无状态的候选消息投递给 Worker
 * （见 workers/antiRaid/floodControl.ts）。
 */

import { visibleSenderChat } from "../users/visibleSender";
import { canBypassFloodControl } from "./memberFacts";
import type { FloodCandidateMessage } from "../types/antiRaid/protocol";
import type { ChatState } from "../types/chatState";
import type { Message, User } from "grammy/types";

/** buildFloodCandidate 的入参。 */
export interface BuildFloodCandidateParams {
  /** 入站 Telegram 群消息。 */
  readonly message: Message;
  /** 本机器人的用户 id。 */
  readonly botId: number;
  /** 当前 update 的统一时间戳（见 infra/updateContext.ts）。 */
  readonly now: number;
  /** 当前群状态。 */
  readonly chatState: Readonly<ChatState>;
}

/**
 * 将群消息收敛为刷屏计数候选；不参与计数时返回 undefined。
 *
 * @param params 入站群消息、机器人 ID、当前时间戳与群状态快照
 * @returns 投递给 Anti-Raid Worker 的刷屏计数候选消息；被豁免或不满足条件时返回 undefined
 */
export function buildFloodCandidate({
  message,
  botId,
  now,
  chatState,
}: BuildFloodCandidateParams): FloodCandidateMessage | undefined {
  if (message.chat.type !== "supergroup") return undefined;
  if (chatState.isFloodControlEnabled !== true) return undefined;
  if (visibleSenderChat(message) !== undefined) return undefined;

  const sender: User | undefined = message.from;
  if (sender === undefined || sender.id === botId) return undefined;
  if (canBypassFloodControl(sender.id)) return undefined;

  return {
    type: "floodCandidate",
    chatId: message.chat.id,
    userId: sender.id,
    observedAt: now,
    name: sender.username ? `@${sender.username}` : sender.first_name,
  };
}
