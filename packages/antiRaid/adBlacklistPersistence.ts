/**
 * 广告检测自动拉黑贴纸包与自定义表情包的主线程写回模块（仅主线程导入）：
 * 规范化、去重并按 `STICKER_PACK_NAME_PATTERN` 校验包名，排除机器人自身 `stickers.json`
 * 配置的贴纸包，经 `packages/infra/adPackBlacklistStorage.ts` 写入主线程 768 LRU 热缓存与 SQLite
 * `ad_pack_blacklists` 表（由观察者立即同步 Anti-Raid Worker 计数），再刷新 `"adPackBlacklist"` 落盘领域。
 */
import { stickerPacksForRecovery } from "../config/stickers";
import {
  addAdPackBlacklistBatch,
  flushAdPackBlacklistWrites,
} from "../infra/adPackBlacklistStorage";
import { logger } from "../infra/logger";
import { collectValidStickerPackNames } from "../libs/stickerPackNames";
import type { AdPackBlacklistBatchAddResult } from "../types/adPackBlacklist";

/** 广告检测自动拉黑贴纸包与自定义表情包的写回入参。 */
export interface AutoBlacklistAdPacksOptions {
  /** 模型归因为广告的贴纸包 short name 列表（待规范化并写入 `sticker` 黑名单）。 */
  readonly stickerPacks: readonly string[];
  /** 模型归因为广告的自定义表情包 short name 列表（待规范化并写入 `emoji` 黑名单）。 */
  readonly emojiPacks: readonly string[];
}

/**
 * 去除首尾空白、按 `STICKER_PACK_NAME_PATTERN` 过滤非法包名并按首次出现顺序去重。
 *
 * @param packs 原始贴纸包或自定义表情包 short name 列表
 * @returns 规范化、合法且去重后的包名列表
 */
function normalizeValidPackNames(packs: readonly string[]): string[] {
  return collectValidStickerPackNames(packs, { trim: true });
}

/**
 * 排除机器人自身 `config/dynamic/stickers.json` 已配置的贴纸包，防止误判拉黑己方贴纸包。
 *
 * @param packs 已规范化且去重的候选贴纸包 short name 列表
 * @returns 排除机器人自身贴纸包后的候选列表
 */
function excludeBotOwnStickerPacks(packs: readonly string[]): string[] {
  const ownPacks: readonly string[] | null = stickerPacksForRecovery();
  if (ownPacks === null || ownPacks.length === 0 || packs.length === 0) {
    return [...packs];
  }
  const ownSet: ReadonlySet<string> = new Set(ownPacks);
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const pack of packs) {
    if (ownSet.has(pack)) {
      excluded.push(pack);
      continue;
    }
    allowed.push(pack);
  }
  if (excluded.length > 0) {
    logger.warn(
      "Excluded bot's own configured sticker packs from ad auto-blacklist.",
      { excludedPacks: excluded }
    );
  }
  return allowed;
}

/**
 * 将模型归因为广告的贴纸包与自定义表情包自动写入 SQLite `ad_pack_blacklists` 并立即生效：
 * - 过滤非法与重复包名，并排除机器人自身 `stickers.json` 配置的贴纸包；
 * - 经 `addAdPackBlacklistBatch` 写入主线程 768 LRU 缓存与 Disk I/O 队列（不设条数硬上限，新增变更经观察者同步 Anti-Raid Worker 计数）；
 * - 调用 `flushAdPackBlacklistWrites` 确认 `"adPackBlacklist"` 领域落盘，失败时仅记告警而不抛错。
 *
 * @param options 待自动拉黑的贴纸包与自定义表情包候选列表
 */
export async function persistAutoBlacklistedAdPacks({
  stickerPacks,
  emojiPacks,
}: AutoBlacklistAdPacksOptions): Promise<void> {
  const normalizedStickers: string[] = normalizeValidPackNames(stickerPacks);
  const normalizedEmojis: string[] = normalizeValidPackNames(emojiPacks);
  const candidateStickers: string[] = excludeBotOwnStickerPacks(normalizedStickers);
  if (candidateStickers.length === 0 && normalizedEmojis.length === 0) return;

  let batchResult: AdPackBlacklistBatchAddResult;
  try {
    batchResult = await addAdPackBlacklistBatch({
      stickerPacks: candidateStickers,
      emojiPacks: normalizedEmojis,
    });
  } catch (error: unknown) {
    logger.warn(
      "Ad detection failed to queue auto-blacklisted packs for persistence.",
      {
        stickerPacks: candidateStickers,
        emojiPacks: normalizedEmojis,
      },
      error
    );
    return;
  }

  if (
    batchResult.addedStickerPacks.length === 0 &&
    batchResult.addedEmojiPacks.length === 0
  ) {
    return;
  }

  let persistedToDisk: boolean = false;
  try {
    persistedToDisk = await flushAdPackBlacklistWrites();
    if (!persistedToDisk) {
      logger.warn(
        "Ad detection auto-blacklisted packs were not confirmed on disk; retaining in memory for replay.",
        {
          addedStickerPacks: batchResult.addedStickerPacks,
          addedEmojiPacks: batchResult.addedEmojiPacks,
        }
      );
    }
  } catch (error: unknown) {
    logger.warn(
      "Ad detection failed to flush auto-blacklisted packs to SQLite; retaining in memory for replay.",
      {
        addedStickerPacks: batchResult.addedStickerPacks,
        addedEmojiPacks: batchResult.addedEmojiPacks,
      },
      error
    );
  }

  logger.info("Auto-blacklisted ad packs.", {
    addedStickerPacks: batchResult.addedStickerPacks,
    addedEmojiPacks: batchResult.addedEmojiPacks,
    persistedToDisk,
  });
}
