/**
 * 广告检测的贴纸包黑名单（`sticker_black_list`）与自定义表情包黑名单（`emoji_black_list`）快路径。
 */

import type { Sticker } from "grammy/types";
import { telegramApi } from "../../../infra/telegram";
import { isTelegramRequestRejected } from "../../../infra/telegram/errors";
import { logger } from "../../../infra/logger";
import {
  adDetectStopping,
  customEmojiSetNames,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES,
  adEmojiBlacklistReason,
  adStickerBlacklistReason,
} from "../../../consts/antiRaid/adDetect";
import { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } from "../../../consts/telegram";
import type {
  AdCandidateEntry,
  AdMessageBundle,
  AdVerdict,
} from "../../../types/antiRaid/adDetect";

/**
 * 检查本次未检条目是否命中贴纸包黑名单（同步快路径）。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @param stickerBlackList 贴纸包黑名单。
 * @returns 命中时返回广告判定结果；未命中时返回 `null`。
 */
export function matchStickerBlacklistFastPath(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[],
  stickerBlackList: ReadonlySet<string>
): AdVerdict | null {
  for (const entry of judged) {
    if (
      entry.seq > bundle.checkedSeq &&
      entry.stickerSetName !== undefined &&
      stickerBlackList.has(entry.stickerSetName)
    ) {
      return { isAd: true, reason: adStickerBlacklistReason(entry.stickerSetName) };
    }
  }
  return null;
}

/**
 * 经主线程统一 Telegram 出站按 TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS 分批查询自定义表情所属表情包，
 * 把每批返回的贴纸写入 customEmojiSetNames 后比对黑名单，命中即停。查询失败时各批共用
 * AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES 次立即重试；4xx 拒绝、预算用尽或进入停机时放弃本轮核对。
 *
 * @param bundle 待检消息束。
 * @param customEmojiIds 去重后的待查询自定义表情 ID 列表。
 * @param emojiBlackList 自定义表情包黑名单。
 * @returns 命中的自定义表情包 short name；未命中或放弃核对时返回 `undefined`。
 */
async function queryBlacklistedCustomEmojiSet(
  bundle: AdMessageBundle,
  customEmojiIds: readonly string[],
  emojiBlackList: ReadonlySet<string>
): Promise<string | undefined> {
  let retriesLeft: number = AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES;
  for (
    let start: number = 0;
    start < customEmojiIds.length;
    start += TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS
  ) {
    const batch: string[] = customEmojiIds.slice(start, start + TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS);
    let stickers: readonly Sticker[];
    for (;;) {
      try {
        stickers = await telegramApi.getCustomEmojiStickers(batch);
        break;
      } catch (error: unknown) {
        if (retriesLeft === 0 || isTelegramRequestRejected(error) || adDetectStopping.current) {
          logger.error(
            "Ad detection failed to query custom emoji stickers; skipping the custom emoji blacklist check:",
            {
              chatId: bundle.chatId,
              senderId: bundle.senderId,
              retriesUsed: AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES - retriesLeft,
            },
            error
          );
          return undefined;
        }
        retriesLeft--;
      }
    }
    let matched: string | undefined;
    for (const sticker of stickers) {
      const setName: string | null = sticker.set_name ?? null;
      if (sticker.custom_emoji_id !== undefined) customEmojiSetNames.set(sticker.custom_emoji_id, setName);
      if (matched === undefined && setName !== null && emojiBlackList.has(setName)) matched = setName;
    }
    if (matched !== undefined) return matched;
  }
  return undefined;
}

/**
 * 核对本次未检条目的自定义表情是否属于黑名单表情包：已在 customEmojiSetNames 的 ID 直接比对，
 * 其余 ID 去重后交给 queryBlacklistedCustomEmojiSet 分批查询。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @param emojiBlackList 非空的自定义表情包黑名单。
 * @returns 命中时返回广告判定结果；未命中或查询失败时返回 `null`。
 */
export async function matchCustomEmojiBlacklistFastPath(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[],
  emojiBlackList: ReadonlySet<string>
): Promise<AdVerdict | null> {
  let uncachedIds: Set<string> | undefined;
  for (const entry of judged) {
    if (entry.seq <= bundle.checkedSeq || entry.customEmojiIds === undefined) continue;
    for (const id of entry.customEmojiIds) {
      const setName: string | null | undefined = customEmojiSetNames.get(id);
      if (setName === undefined) {
        uncachedIds ??= new Set<string>();
        uncachedIds.add(id);
      } else if (setName !== null && emojiBlackList.has(setName)) {
        return { isAd: true, reason: adEmojiBlacklistReason(setName) };
      }
    }
  }
  if (uncachedIds === undefined) return null;
  const matchedEmojiSet: string | undefined =
    await queryBlacklistedCustomEmojiSet(bundle, [...uncachedIds], emojiBlackList);
  return matchedEmojiSet === undefined
    ? null
    : { isAd: true, reason: adEmojiBlacklistReason(matchedEmojiSet) };
}
