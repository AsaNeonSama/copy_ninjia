/** groupCommandContext 的可选项；未给出的字段取群命令测试里最常见的形态。 */
export interface GroupCommandContextOptions {
  readonly match?: string;
  /** 发令者 id；null 表示这条 update 不带 from。 */
  readonly userId?: number | null;
  readonly chatId?: number;
  readonly chatType?: string;
  /** 命令消息的 message_id，同时作为 msgId。 */
  readonly messageId?: number;
  /** 命令消息回复的那条消息；缺省时命令消息不带 reply_to_message。 */
  readonly replyToMessage?: object;
}

/**
 * grammY CommandContext 的最小替身：超级群 -1001 里 id 100 的「Admin」用消息 10 发令，机器人 id 999。
 * 只填命令处理器会读的字段，以 never 交给被测函数。
 */
export function groupCommandContext({
  match = "",
  userId = 100,
  chatId = -1001,
  chatType = "supergroup",
  messageId = 10,
  replyToMessage,
}: GroupCommandContextOptions = {}): never {
  const chat: { id: number; type: string } = { id: chatId, type: chatType };
  return {
    chat,
    from: userId === null ? undefined : { id: userId, first_name: "Admin", username: "admin" },
    msg: {
      message_id: messageId,
      chat,
      ...(replyToMessage === undefined ? {} : { reply_to_message: replyToMessage }),
    },
    msgId: messageId,
    me: { id: 999 },
    match,
  } as never;
}
