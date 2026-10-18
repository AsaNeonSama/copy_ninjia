import { ABUSE_MARK_DURATION_MINUTES } from "../../aiChat/rateLimit";

/** 达到回复限频时发送给群聊的固定提示。 */
export const RATE_LIMIT_NOTICE_TEXT: string = "本群 AI 回复请求过于频繁，请稍后再试。";

/** 调用 abuse_mark 标记用户后在群内发出的普通风格提示。 */
export const ABUSE_MARK_NOTICE_TEXT: string =
  `检测到反复发送不当请求，接下来 ${ABUSE_MARK_DURATION_MINUTES} 分钟内将不再响应你的消息。`;
