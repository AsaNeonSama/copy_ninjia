import { ABUSE_MARK_DURATION_MINUTES } from "../../aiChat/rateLimit";

/** 达到回复限频时发送给群聊的固定提示。 */
export const RATE_LIMIT_NOTICE_TEXT: string = "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡";

/** 调用 abuse_mark 标记用户后在群内发出的角色风格提示。 */
export const ABUSE_MARK_NOTICE_TEXT: string =
  `啧，翻来覆去全是些莫名其妙的鬼话，烦死人了！本天才不理你了，乖乖等 ${ABUSE_MARK_DURATION_MINUTES} 分钟吧杂鱼♡`;
