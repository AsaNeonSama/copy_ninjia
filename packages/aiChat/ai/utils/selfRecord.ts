import { SELF_SPEAKER_NAME } from "../../../consts/aiChat/prompts/transcript";
import type {
  AiBotInfo,
  AiRecordMessage,
} from "../../../types/aiChat/protocol";
import type { BufferedReplyReference } from "../../../types/aiChat/memory";

/**
 * 构造机器人将自身发出的消息写回滚动记忆时的 AiRecordMessage 载荷。
 */
export interface SelfRecordMessageParams {
  chatId: number;
  /** 机器人账号身份。 */
  self: AiBotInfo;
  /** 已发出消息的 message_id。 */
  messageId: number;
  /** 自录消息正文。 */
  text: string;
  /** 可选的回复引用快照。 */
  replyTo?: BufferedReplyReference | undefined;
}

export function buildSelfRecordMessage({
  chatId,
  self,
  messageId,
  text,
  replyTo,
}: SelfRecordMessageParams): AiRecordMessage {
  return {
    type: "record",
    chatId,
    senderId: self.id,
    firstName: SELF_SPEAKER_NAME,
    lastName: "",
    username: undefined,
    messageId,
    replyTo: replyTo === undefined ? undefined : {
      messageId: replyTo.messageId,
      id: replyTo.id,
      firstName: replyTo.firstName,
      lastName: replyTo.lastName,
      username: replyTo.username,
      text: replyTo.text,
      quote: replyTo.quote,
      forwardedFrom: replyTo.forwardedFrom,
      botImage: undefined,
    },
    forwardedFrom: undefined,
    persistImmediately: false,
    text,
  };
}
