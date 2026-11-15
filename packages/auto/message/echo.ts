import type { Message } from "grammy/types";
import type { CopyMode } from "../../types/chatState";
import { sendEchoPayload } from "../../copy/echo";
import { applyCopyModeTransform } from "../../copy/copyModes";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../consts/telegram";
import { containsRenderableCommand } from "../../libs/renderableCommand";

/** 复读或变体复读单条消息的上下文参数。 */
export interface EchoMessageParams {
  /** 目标聊天 ID */
  readonly chatId: number;
  /** 待复读的源消息 */
  readonly message: Message;
  /** 复读变体模式；`undefined` 表示原样复读 */
  readonly mode: CopyMode | undefined;
  /**
   * 复读要落进的论坛话题；General、非论坛群为 undefined。
   *
   * 复读不挂回复，话题由本参数确定（判定见 libs/forumTopic.ts）。
   */
  readonly messageThreadId?: number;
}

/**
 * 将消息复读回所在会话（`/copy` 系列与随机复读）：
 * - 文字与图注统一按纯字符串处理（有模式时做变体变换，不保留原格式实体），经 `copy/echo.ts` 的 `sendEchoPayload` 发出。
 * - 原文或变换后的文本只要包含可渲染命令片段，或变换后超出正文/图注长度上限，均整条丢弃（不退回原样复制）。
 *
 * @param params 复读上下文（含目标会话 `chatId`、源消息 `message`、变体模式 `mode` 与可选话题 `messageThreadId`）。
 */
export async function echoMessage({
  chatId,
  message,
  mode,
  messageThreadId,
}: EchoMessageParams): Promise<void> {
  const source: string | undefined = message.text ?? message.caption;
  if (source !== undefined && containsRenderableCommand(source)) return;

  const text: string | undefined = source === undefined ? undefined : applyCopyModeTransform(source, mode);
  if (text !== undefined) {
    if (containsRenderableCommand(text)) return;
    const limit: number = typeof message.text === "string" ? TELEGRAM_MESSAGE_MAX_CHARS : TELEGRAM_CAPTION_MAX_CHARS;
    if (text.length > limit) return;
  }

  await sendEchoPayload({ chatId, message, text, messageThreadId });
}
