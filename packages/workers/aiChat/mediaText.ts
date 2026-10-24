import type { AiRecordMediaMessage } from "../../types/aiChat/protocol";
import type { BotImageOrigin } from "../../types/aiChat/memory";
import { botImageTagTemplate } from "../../consts/aiChat/prompts/transcript";
import type { MediaKind } from "../../types/media";
import {
  ANIMATION_FALLBACK_PLACEHOLDER,
  ANIMATION_PENDING_PLACEHOLDER,
  IMAGE_FALLBACK_PLACEHOLDER,
  IMAGE_PENDING_PLACEHOLDER,
  STICKER_FALLBACK_PLACEHOLDER,
  STICKER_PENDING_PLACEHOLDER,
} from "../../consts/aiChat/media";
import { VOICE_FALLBACK_PLACEHOLDER, VOICE_PENDING_PLACEHOLDER } from "../../consts/aiChat/voice";

/** 媒体转录行、占位文本与回填标签的字符串组装。 */

/**
 * 媒体描述未解析完成时的占位文本。
 *
 * @param kind 媒体类型
 * @returns 对应媒体类型的解析中占位标签文本
 */
export function pendingPlaceholderFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_PENDING_PLACEHOLDER;
    case "animation":
      return ANIMATION_PENDING_PLACEHOLDER;
    case "voice":
      return VOICE_PENDING_PLACEHOLDER;
    default:
      return IMAGE_PENDING_PLACEHOLDER;
  }
}

/**
 * 媒体解析成功后回填的描述标签。
 *
 * @param kind 媒体类型
 * @param description 识图或转写得到的媒体描述文本
 * @returns 带类型前缀的媒体描述标签
 */
export function resolvedTagFor(kind: MediaKind, description: string): string {
  switch (kind) {
    case "sticker":
      return `[贴纸：${description}]`;
    case "animation":
      return `[GIF：${description}]`;
    case "voice":
      return `[语音：${description}]`;
    default:
      return `[图片：${description}]`;
  }
}

/**
 * 媒体解析失败时回填的兜底文本（贴纸优先使用元数据行）。
 *
 * @param kind 媒体类型
 * @param msg 入站媒体记录消息
 * @returns 解析失败时写入滚动记忆的兜底占位文本
 */
export function fallbackTextFor(kind: MediaKind, msg: AiRecordMediaMessage): string {
  if (kind === "sticker") return msg.stickerFallbackText ?? STICKER_FALLBACK_PLACEHOLDER;
  if (kind === "animation") return ANIMATION_FALLBACK_PLACEHOLDER;
  if (kind === "voice") return VOICE_FALLBACK_PLACEHOLDER;
  return IMAGE_FALLBACK_PLACEHOLDER;
}

/**
 * 直接触发的媒体解析失败时用于回复任务指令的兜底描述。
 *
 * @param msg 入站媒体记录消息
 * @returns 供回复任务提示词消费的解析失败说明文本
 */
export function replyFallbackDescriptionFor(msg: AiRecordMediaMessage): string {
  if (msg.kind === "sticker" && msg.stickerFallbackText) return msg.stickerFallbackText;
  if (msg.kind === "voice") return "（这条语音没能识别出来，你没听清对方说了什么）";
  return "（画面内容没能识别出来，你没看清对方发了什么）";
}

/**
 * 拼接机器人自发图片的转录记号与图注。
 *
 * @param origin 机器人图片发出源（命令/定时任务、生图或修图）
 * @param detail 识图描述或生成提示词详情；占位态为空串
 * @param caption 清洗后的随图图注
 * @returns 拼接后的机器人图片转录文本
 */
export function botImageText(origin: BotImageOrigin, detail: string, caption: string): string {
  return `${botImageTagTemplate(origin, detail)}${caption}`;
}
