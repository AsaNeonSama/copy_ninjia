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
 * 将消息复读回所在聊天（`/copy` 系与随机复读）。文字与图注一律按字符串处理：有模式时
 * 变换，没有模式时原样使用，链接、@ 与格式实体不单独处理；发送经 copy/echo.ts 的
 * sendEchoPayload（纯文字重新发送，媒体复制并换图注）。
 *
 * @param params 复读上下文（含目标会话 `chatId`、源消息 `message`、变体模式 `mode` 与可选话题 `messageThreadId`）。
 */
export async function echoMessage({
  chatId,
  message,
  mode,
  messageThreadId,
}: EchoMessageParams): Promise<void> {
  // 正文与 caption 均检查是否含可点击命令片段。
  const source: string | undefined = message.text ?? message.caption;
  if (source !== undefined && containsRenderableCommand(source)) return;

  const text: string | undefined = source === undefined ? undefined : applyCopyModeTransform(source, mode);
  if (text !== undefined) {
    // 变换后的输出串再次检查是否含可点击命令片段；命中即整条丢弃，不退化成原样复制。
    if (containsRenderableCommand(text)) return;
    // 变换后超过长度上限时整条丢弃。
    const limit: number = typeof message.text === "string" ? TELEGRAM_MESSAGE_MAX_CHARS : TELEGRAM_CAPTION_MAX_CHARS;
    if (text.length > limit) return;
  }

  await sendEchoPayload({ chatId, message, text, messageThreadId });
}
