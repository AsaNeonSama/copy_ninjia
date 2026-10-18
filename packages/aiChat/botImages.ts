import { isAiChatActiveIn } from "./availability";
import { recordChatMessage } from "./messageIngress";
import { logger } from "../infra/logger";
import { activeCopyTargetIdIn } from "../infra/storage/stateStore";

/** recordBotImage 的入参。 */
export interface RecordBotImageParams {
  chatId: number;
  /** 图片消息的 message_id。 */
  messageId: number;
  /** 图注原文；无图注时传空串。 */
  caption: string;
  /** 是否为原消息换图。 */
  edited: boolean;
}

/**
 * 在本群启用 AI 闲聊且未处于复读模式时，向 AI Worker 投递一条占位态机器人图片自录消息；
 * 投递失败时记录错误日志并返回。
 */
export function recordBotImage({ chatId, messageId, caption, edited }: RecordBotImageParams): void {
  if (activeCopyTargetIdIn(chatId) !== undefined || !isAiChatActiveIn(chatId)) return;
  try {
    recordChatMessage({
      type: "recordBotImage",
      chatId,
      messageId,
      caption,
      edited,
      persistImmediately: false,
    });
  } catch (error: unknown) {
    logger.error(`Failed to record bot image ${messageId} in AI memory (chat ${chatId}):`, error);
  }
}
