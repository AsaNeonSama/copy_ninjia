/**
 * 广告检测的贴纸包黑名单与自定义表情包黑名单快路径（条数非零时经双工桥向主线程 768 LRU / SQLite 核对），
 * 以及供多模态视觉检测复用的自定义表情元数据分批查询与 LRU 缓存写入逻辑。
 */

import type { Sticker } from "grammy/types";
import { telegramApi } from "../../../infra/telegram";
import { isTelegramRequestRejected } from "../../../infra/telegram/errors";
import { logger } from "../../../infra/logger";
import {
  adDetectStopping,
  adPackBlacklistCounts,
  customEmojiMetaCache,
} from "../../../cache/workers/antiRaid/adDetect";
import { STICKER_PACK_NAME_PATTERN } from "../../../consts/aiChat/stickers";
import {
  AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES,
  MISSING_CUSTOM_EMOJI_META,
  adEmojiBlacklistReason,
  adStickerBlacklistReason,
} from "../../../consts/antiRaid/adDetect/limits";
import { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } from "../../../consts/telegram";
import { pickStickerVisionSource } from "../../../libs/telegramImage";
import type { AdPackBlacklistKind } from "../../../types/adPackBlacklist";
import type {
  AdCandidateEntry,
  AdMessageBundle,
  AdVerdict,
  CachedCustomEmojiMeta,
} from "../../../types/antiRaid/adDetect";
import type { TelegramVisionSource } from "../../../types/media";
import { requestMatchAdPackBlacklist } from "./blacklistLookup";

/** `matchCustomEmojiBlacklistFastPath` 的核对结果。 */
export interface CustomEmojiBlacklistMatchResult {
  /** 命中黑名单时返回广告判定结果；未命中或查询失败时为 `null`。 */
  readonly verdict: AdVerdict | null;
  /** 本轮查询 Telegram 自定义表情接口是否因重试耗尽、4xx 拒绝或停机而中止。 */
  readonly queryFailed: boolean;
}

/** 分批查询未缓存自定义表情的内部返回结果。 */
interface FetchCustomEmojiBatchResult {
  /** 若启用黑名单检查且命中，则返回首个命中的表情包 short name。 */
  readonly matchedSetName: string | undefined;
  /** 本轮查询是否因重试耗尽、4xx 拒绝或停机而提前中止。 */
  readonly queryFailed: boolean;
}

/**
 * 向主线程核对一批候选包名是否命中指定种类的广告黑名单；停机以外的查询异常记错误日志并 fail-safe 返回 `null`。
 *
 * @param bundle 待检消息束（用于错误日志上下文）。
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param packs 去重且符合 `STICKER_PACK_NAME_PATTERN` 的候选包名列表。
 * @returns 命中的首个包名；未命中或查库失败时返回 `null`。
 */
async function lookupBlacklistedPackFailSafe(
  bundle: AdMessageBundle,
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): Promise<string | null> {
  if (packs.length === 0) return null;
  try {
    return await requestMatchAdPackBlacklist(kind, packs);
  } catch (error: unknown) {
    if (!adDetectStopping.current) {
      logger.error(
        "Ad detection failed to check ad pack blacklist; skipping fast-path match:",
        {
          chatId: bundle.chatId,
          senderId: bundle.senderId,
          kind,
          packCount: packs.length,
        },
        error
      );
    }
    return null;
  }
}

/**
 * 检查本次未检条目是否命中贴纸包黑名单：贴纸黑名单条数为 0 时 O(1) 同步短路；
 * 否则收集去重且合法的贴纸包名经主线程 768 LRU / SQLite 核对。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @returns 命中时返回广告判定结果；未命中或查询失败时返回 `null`。
 */
export async function matchStickerBlacklistFastPath(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): Promise<AdVerdict | null> {
  if (adPackBlacklistCounts.sticker <= 0) return null;
  let firstPack: string | undefined;
  let packs: string[] | undefined;
  let seen: Set<string> | undefined;
  for (const entry of judged) {
    if (entry.seq <= bundle.checkedSeq) continue;
    const setName: string | undefined = entry.stickerSetName;
    if (setName === undefined || !STICKER_PACK_NAME_PATTERN.test(setName)) continue;
    if (firstPack === undefined) {
      firstPack = setName;
    } else if (packs === undefined) {
      if (setName !== firstPack) {
        seen = new Set<string>([firstPack, setName]);
        packs = [firstPack, setName];
      }
    } else if (!seen!.has(setName)) {
      seen!.add(setName);
      packs.push(setName);
    }
  }
  if (firstPack === undefined) return null;
  const matchedPack: string | null = await lookupBlacklistedPackFailSafe(
    bundle,
    "sticker",
    packs ?? [firstPack]
  );
  return matchedPack === null
    ? null
    : { isAd: true, reason: adStickerBlacklistReason(matchedPack) };
}

/** `fetchUncachedCustomEmojiMetadata` 分批查询未缓存自定义表情的入参。 */
interface FetchCustomEmojiBatchParams {
  /** 待检消息束。 */
  readonly bundle: AdMessageBundle;
  /** 去重后的待查询自定义表情 ID 列表。 */
  readonly uncachedIds: readonly string[];
  /** 为 `true` 时每批解析完后立即经主线程核对自定义表情包黑名单，命中即停。 */
  readonly checkBlacklist?: boolean;
  /** 可选的本轮结果收集表，同步写入每个成功解析（含缺省负缓存）的条目。 */
  readonly resolvedOut?: Map<string, CachedCustomEmojiMeta>;
}

/**
 * 经主线程统一 Telegram 出站按 TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS 分批查询自定义表情元数据，
 * 严格按 `sticker.custom_emoji_id` 写入 `customEmojiMetaCache`，对成功响应中省略的 ID 写入全 `null` 负缓存；
 * 查询失败时各批共用 AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES 次立即重试，失败批次不写缓存。
 * 启用 `checkBlacklist` 时，每批解析出的合法包名立即向主线程 768 LRU / SQLite 核对，首个命中批次后即停。
 *
 * @param params 消息束、未缓存表情 ID 列表及可选黑名单核对开关与结果收集表。
 * @returns 黑名单命中包名及是否因查询失败中止。
 */
async function fetchUncachedCustomEmojiMetadata({
  bundle,
  uncachedIds,
  checkBlacklist = false,
  resolvedOut,
}: FetchCustomEmojiBatchParams): Promise<FetchCustomEmojiBatchResult> {
  let retriesLeft: number = AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES;
  for (
    let start: number = 0;
    start < uncachedIds.length;
    start += TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS
  ) {
    const batch: string[] = uncachedIds.slice(start, start + TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS);
    let stickers: readonly Sticker[];
    for (;;) {
      try {
        stickers = await telegramApi.getCustomEmojiStickers(batch);
        break;
      } catch (error: unknown) {
        if (retriesLeft === 0 || isTelegramRequestRejected(error) || adDetectStopping.current) {
          logger.error(
            checkBlacklist
              ? "Ad detection failed to query custom emoji stickers; skipping the custom emoji blacklist check:"
              : "Ad detection failed to query custom emoji stickers; skipping remaining custom emoji media:",
            {
              chatId: bundle.chatId,
              senderId: bundle.senderId,
              retriesUsed: AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES - retriesLeft,
            },
            error
          );
          return { matchedSetName: undefined, queryFailed: true };
        }
        retriesLeft--;
      }
    }
    const returnedIds: Set<string> = new Set<string>();
    const batchSetNames: string[] = [];
    const seenBatchSetNames: Set<string> = new Set<string>();
    for (const sticker of stickers) {
      const emojiId: string | undefined = sticker.custom_emoji_id;
      if (emojiId === undefined) continue;
      const vision: TelegramVisionSource | null = pickStickerVisionSource(sticker);
      const meta: CachedCustomEmojiMeta = {
        setName: sticker.set_name ?? null,
        visionFileId: vision?.fileId ?? null,
        fileUniqueId: sticker.file_unique_id,
      };
      customEmojiMetaCache.set(emojiId, meta);
      resolvedOut?.set(emojiId, meta);
      returnedIds.add(emojiId);
      if (
        checkBlacklist &&
        meta.setName !== null &&
        STICKER_PACK_NAME_PATTERN.test(meta.setName) &&
        !seenBatchSetNames.has(meta.setName)
      ) {
        seenBatchSetNames.add(meta.setName);
        batchSetNames.push(meta.setName);
      }
    }
    for (const id of batch) {
      if (returnedIds.has(id)) continue;
      customEmojiMetaCache.set(id, MISSING_CUSTOM_EMOJI_META);
      resolvedOut?.set(id, MISSING_CUSTOM_EMOJI_META);
    }
    if (checkBlacklist && batchSetNames.length > 0) {
      const matched: string | null = await lookupBlacklistedPackFailSafe(
        bundle,
        "emoji",
        batchSetNames
      );
      if (matched !== null) {
        return { matchedSetName: matched, queryFailed: false };
      }
    }
  }
  return { matchedSetName: undefined, queryFailed: false };
}

/**
 * 解析自定义表情 ID 列表对应的所属包名与可下载视觉素材标识：优先命中 `customEmojiMetaCache`，
 * 未命中且允许出站查询时按 `TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS` 分批查询 Telegram 并回填缓存。
 *
 * @param bundle 待检消息束。
 * @param customEmojiIds 待解析的自定义表情 ID 列表。
 * @param skipNetworkQuery 为 `true` 时仅读取本线程缓存，不发起新的 Telegram 查询。
 * @returns 已解析的自定义表情 ID -> 元数据只读映射表。
 */
export async function resolveCustomEmojiMetadata(
  bundle: AdMessageBundle,
  customEmojiIds: readonly string[],
  skipNetworkQuery: boolean = false
): Promise<ReadonlyMap<string, CachedCustomEmojiMeta>> {
  const resolved: Map<string, CachedCustomEmojiMeta> = new Map<string, CachedCustomEmojiMeta>();
  let uncachedIds: Set<string> | undefined;
  for (const id of customEmojiIds) {
    if (resolved.has(id)) continue;
    const cached: CachedCustomEmojiMeta | undefined = customEmojiMetaCache.get(id);
    if (cached !== undefined) {
      resolved.set(id, cached);
    } else if (!skipNetworkQuery) {
      uncachedIds ??= new Set<string>();
      uncachedIds.add(id);
    }
  }
  if (uncachedIds !== undefined && uncachedIds.size > 0) {
    await fetchUncachedCustomEmojiMetadata({
      bundle,
      uncachedIds: [...uncachedIds],
      resolvedOut: resolved,
    });
  }
  return resolved;
}

/**
 * 核对本次未检条目的自定义表情是否属于黑名单表情包：先汇总已在 `customEmojiMetaCache` 命中的去重包名
 * 经主线程 768 LRU / SQLite 批量核对；未命中时再把未缓存 ID 去重后交给 `fetchUncachedCustomEmojiMetadata`
 * 分批查询 Telegram 并同步核对黑名单与缓存视觉元数据。
 *
 * @param bundle 待检消息束。
 * @param judged 本次送检入选的条目快照。
 * @returns 黑名单命中判定结果及是否发生 Telegram 查询中止。
 */
export async function matchCustomEmojiBlacklistFastPath(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): Promise<CustomEmojiBlacklistMatchResult> {
  if (adPackBlacklistCounts.emoji <= 0) {
    return { verdict: null, queryFailed: false };
  }
  let uncachedIds: Set<string> | undefined;
  let firstCachedSetName: string | undefined;
  let cachedSetNames: string[] | undefined;
  let seenCachedSetNames: Set<string> | undefined;
  for (const entry of judged) {
    if (entry.seq <= bundle.checkedSeq || entry.customEmojiIds === undefined) continue;
    for (const id of entry.customEmojiIds) {
      const meta: CachedCustomEmojiMeta | undefined = customEmojiMetaCache.get(id);
      if (meta === undefined) {
        uncachedIds ??= new Set<string>();
        uncachedIds.add(id);
      } else if (meta.setName !== null && STICKER_PACK_NAME_PATTERN.test(meta.setName)) {
        if (firstCachedSetName === undefined) {
          firstCachedSetName = meta.setName;
        } else if (cachedSetNames === undefined) {
          if (meta.setName !== firstCachedSetName) {
            seenCachedSetNames = new Set<string>([firstCachedSetName, meta.setName]);
            cachedSetNames = [firstCachedSetName, meta.setName];
          }
        } else if (!seenCachedSetNames!.has(meta.setName)) {
          seenCachedSetNames!.add(meta.setName);
          cachedSetNames.push(meta.setName);
        }
      }
    }
  }
  if (firstCachedSetName !== undefined) {
    const matchedCached: string | null = await lookupBlacklistedPackFailSafe(
      bundle,
      "emoji",
      cachedSetNames ?? [firstCachedSetName]
    );
    if (matchedCached !== null) {
      return {
        verdict: { isAd: true, reason: adEmojiBlacklistReason(matchedCached) },
        queryFailed: false,
      };
    }
  }
  if (uncachedIds === undefined) {
    return { verdict: null, queryFailed: false };
  }
  const { matchedSetName, queryFailed }: FetchCustomEmojiBatchResult =
    await fetchUncachedCustomEmojiMetadata({
      bundle,
      uncachedIds: [...uncachedIds],
      checkBlacklist: true,
    });
  return {
    verdict: matchedSetName === undefined
      ? null
      : { isAd: true, reason: adEmojiBlacklistReason(matchedSetName) },
    queryFailed,
  };
}
