import {
  MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN,
  MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN,
  STICKER_PACK_NAME_PATTERN,
} from "../consts/miniApp/ui";
import type { MiniAppAdBlacklistKind } from "../types/miniApp/adBlacklists";

/** 解析内容黑名单添加输入（纯 short name 或 Telegram 贴纸/表情包链接）后的目标种类与规范化包名。 */
export interface ParsedAdBlacklistPackInput {
  /** 解析出的目标黑名单种类；纯包名沿用当前激活子页签种类，Telegram 链接按 `addstickers`/`addemoji` 自动归类。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 通过 `STICKER_PACK_NAME_PATTERN` 校验的规范化 short name（保留原始大小写）。 */
  readonly pack: string;
}

/**
 * 将内容黑名单添加输入框文本规范化为目标种类与包 short name：
 * - 纯 short name（满足 `STICKER_PACK_NAME_PATTERN`）：沿用 `fallbackKind`；
 * - Telegram 网页分享链接（`[http(s)://](t.me|telegram.me|telegram.dog)/(addstickers|addemoji)/<pack>[/]`）或原生深链（`tg://(addstickers|addemoji)[/]?set=<pack>`）：按链接类型自动归类为 `"sticker"` 或 `"emoji"`，保留包名原始大小写并按 `STICKER_PACK_NAME_PATTERN` 校验；
 * - 其余非法格式返回 `null`。
 *
 * @param rawInput 用户在添加输入框内填写的原始文本
 * @param fallbackKind 输入为纯包名时沿用的当前子页签种类
 * @returns 解析出的 `{ kind, pack }`，输入非法时返回 `null`
 */
export function parseAdBlacklistPackInput(
  rawInput: string,
  fallbackKind: MiniAppAdBlacklistKind
): Readonly<ParsedAdBlacklistPackInput> | null {
  const trimmed: string = rawInput.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (STICKER_PACK_NAME_PATTERN.test(trimmed)) {
    return { kind: fallbackKind, pack: trimmed };
  }

  const linkMatch: RegExpExecArray | null =
    MINI_APP_TELEGRAM_PACK_WEB_LINK_PATTERN.exec(trimmed) ??
    MINI_APP_TELEGRAM_PACK_TG_LINK_PATTERN.exec(trimmed);
  if (linkMatch === null) {
    return null;
  }

  const actionSegment: string | undefined = linkMatch[1];
  const candidatePack: string | undefined = linkMatch[2];
  if (
    actionSegment === undefined ||
    candidatePack === undefined ||
    !STICKER_PACK_NAME_PATTERN.test(candidatePack)
  ) {
    return null;
  }

  const kind: MiniAppAdBlacklistKind =
    actionSegment.toLowerCase() === "addemoji" ? "emoji" : "sticker";
  return { kind, pack: candidatePack };
}

/**
 * 根据内容黑名单种类与 short name 构造 Telegram 外部包链接。
 *
 * @param kind 黑名单种类（`"sticker"` 或 `"emoji"`）
 * @param pack Telegram 贴纸包或自定义表情包 short name
 * @returns 对应的 `https://t.me/addstickers/<pack>` 或 `https://t.me/addemoji/<pack>` 链接
 */
export function buildAdBlacklistPackUrl(
  kind: MiniAppAdBlacklistKind,
  pack: string
): string {
  const encoded: string = encodeURIComponent(pack);
  return kind === "sticker"
    ? `https://t.me/addstickers/${encoded}`
    : `https://t.me/addemoji/${encoded}`;
}
