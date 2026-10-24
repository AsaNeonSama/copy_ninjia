import { InlineKeyboard } from "grammy";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { User } from "grammy/types";
import { WED_CALLBACK_PREFIX, WED_NAME_MAX_CHARS } from "../../consts/wed";

import { truncateInline } from "../../libs/text";
import type { RichTextMessage } from "../../types/telegram";
import { formatFullName } from "../../users/userLabel";

/**
 * 昵称作为纯文本拼接，实体偏移按 UTF-16 计算。
 * @param actor 发起 `/wed` 命令的用户。
 * @param target 抽中的候选用户。
 * @param atmosphere 语气词表。
 * @returns 带用户提及实体的富文本图注。
 */
export function renderWedCaption(actor: User, target: User, atmosphere: AtmosphereTexts): RichTextMessage {
  const actorName: string = truncateInline(formatFullName(actor, atmosphere), WED_NAME_MAX_CHARS);
  const targetName: string = truncateInline(formatFullName(target, atmosphere), WED_NAME_MAX_CHARS);
  const prefix: string = `${actorName}，你的群友老婆是 `;
  return {
    text: `${prefix}${targetName}!`,
    entities: [
      { type: "text_mention", offset: 0, length: actorName.length, user: actor },
      { type: "text_mention", offset: prefix.length, length: targetName.length, user: target },
    ],
  };
}

/** 按钮状态和本次渲染所用的群文案。 */
export interface WedKeyboardOptions {
  /** 是否已点击确认求婚。 */
  readonly confirmed?: boolean;
  /** 语气词表。 */
  readonly atmosphere: AtmosphereTexts;
}

/**
 * 单排按钮绑定发起人和当前目标，消息 ID 由 Telegram 回传。
 * @param actorId 发起人用户 ID。
 * @param targetId 当前抽中的目标用户 ID。
 * @param options 是否已确认求婚（`confirmed`）及当前语气词表（`atmosphere`）。
 * @returns 构造好的内联键盘。
 */
export function buildWedKeyboard(actorId: number, targetId: number, { confirmed = false, atmosphere }: WedKeyboardOptions): InlineKeyboard {
  return new InlineKeyboard()
    .text(atmosphere.WED_BUTTON_TEXTS.remove, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:remove`)
    .text(confirmed ? atmosphere.WED_BUTTON_TEXTS.confirmed : atmosphere.WED_BUTTON_TEXTS.marry, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:marry`)
    .text(atmosphere.WED_BUTTON_TEXTS.change, `${WED_CALLBACK_PREFIX}${actorId}:${targetId}:change`);
}
