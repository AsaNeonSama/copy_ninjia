/**
 * 广告检测的多模态视觉素材解析、并发下载与转码（Anti-Raid Worker 侧）：
 * - 汇总消息束内的普通图片/图片文件、贴纸与自定义表情视觉源；
 * - 复用 `./blacklistFastPath.ts` 的 `resolveCustomEmojiMetadata` 解析自定义表情元数据；
 * - 按 `fileUniqueId` 去重，先选未检条目再按新到旧回填已判上下文并限制至 `AD_DETECT_MAX_IMAGES_PER_BUNDLE` 张，
 *   使用 `Promise.allSettled` 并发拉取并经 `prepareVisionImage` 转为 JPEG/PNG；
 * - 按 `MEDIA_MAX_DOWNLOAD_BYTES` 强制单束累积字节预算（优先保留未检附件），按时间顺序产出整串（`combined`）
 *   与发送者本人直发（`direct`）两份切片，供引用归因免重复下载。
 */

import { adDetectStopping } from "../../../cache/workers/antiRaid/adDetect";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../consts/aiChat/media";
import { STICKER_PACK_NAME_PATTERN } from "../../../consts/aiChat/stickers";
import {
  AD_DETECT_MAX_IMAGES_PER_BUNDLE,
  EMPTY_RESOLVED_AD_BUNDLE_MEDIA,
} from "../../../consts/antiRaid/adDetect/limits";
import { prepareVisionImage } from "../../../infra/image";
import { logger } from "../../../infra/logger";
import { downloadTelegramFileFromMain } from "../../../infra/telegram/workerClient";
import type {
  AdBundleMediaSlice,
  AdCandidateEntry,
  AdDetectMediaAttachment,
  AdDetectMediaKind,
  AdMessageBundle,
  CachedCustomEmojiMeta,
  ResolvedAdBundleMedia,
} from "../../../types/antiRaid/adDetect";
import type { VisionImage } from "../../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../../types/telegramWorker";
import { resolveCustomEmojiMetadata } from "./blacklistFastPath";

export type { AdBundleMediaSlice, ResolvedAdBundleMedia } from "../../../types/antiRaid/adDetect";

/** `resolveAdBundleMedia` 解析消息束多模态素材的入参。 */
export interface ResolveAdBundleMediaParams {
  /** 待检消息束（提供群/发送者日志上下文与已检水位 `checkedSeq`）。 */
  readonly bundle: AdMessageBundle;
  /** 本次送检入选的条目快照（已判上下文在前、未判条目在后）。 */
  readonly judged: readonly AdCandidateEntry[];
  /** 本次送检是否存在尚未做过文本判定的非空文本条目。 */
  readonly hasUncheckedText: boolean;
  /** 为 `true` 时自定义表情元数据仅读缓存、不重复调用 Telegram API。 */
  readonly skipCustomEmojiNetworkQuery?: boolean;
}

/** 待下载的去重视觉素材条目。 */
interface PendingMediaCandidate {
  /** 稳定去重键（`kind:uniqueId`）。 */
  readonly uniqueKey: string;
  /** 媒体来源类型。 */
  readonly kind: AdDetectMediaKind;
  /** 用于主线程下载的 Telegram `file_id`。 */
  readonly fileId: string;
  /** 贴纸或自定义表情所属包的 short name；普通图片或无所属包时为 `undefined`。 */
  readonly packName: string | undefined;
  /** 是否至少在一条未检条目（`entry.seq > checkedSeq`）中出现过。 */
  readonly hasUnchecked: boolean;
  /** 首次出现条目在 `judged` 中的下标（用于最终按时间顺序排列输出）。 */
  orderEntryIndex: number;
  /** 同一条目内的视觉槽位顺序号（photo -> sticker -> custom_emoji）。 */
  orderSlotIndex: number;
  /** 是否至少在一条发送者本人直发（`!isForwarded`）的消息中出现过。 */
  isDirect: boolean;
}

/** `collectCustomEmojiIds` 按未检或上下文范围筛选自定义表情 ID 的条件。 */
interface CustomEmojiIdFilter {
  /** 消息束已检水位，用于区分未检与已判上下文条目。 */
  readonly checkedSeq: number;
  /** 为 `true` 时仅收集未检条目（`seq > checkedSeq`），为 `false` 时仅收集已判上下文条目（`seq <= checkedSeq`）。 */
  readonly unchecked: boolean;
  /** 可选的已解析元数据表；传入时跳过其中已存在的 ID。 */
  readonly exclude?: ReadonlyMap<string, CachedCustomEmojiMeta>;
}

/**
 * 按条目时间顺序收集消息束内符合条件的自定义表情 ID（去重保序）。
 *
 * @param judged 本次送检入选的条目快照。
 * @param filter 可选的未检/上下文筛选与已解析跳过条件；缺省时收集全部条目。
 * @returns 去重后的自定义表情 ID 列表。
 */
function collectCustomEmojiIds(
  judged: readonly AdCandidateEntry[],
  filter?: CustomEmojiIdFilter
): string[] {
  const ids: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const entry of judged) {
    if (filter !== undefined && (entry.seq > filter.checkedSeq) !== filter.unchecked) continue;
    if (entry.customEmojiIds === undefined) continue;
    for (const id of entry.customEmojiIds) {
      if (seen.has(id) || filter?.exclude?.has(id) === true) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 将单个视觉候选登记到待下载列表：按 `uniqueKey` 去重，命中已有候选时透传 `isDirect`
 * 并回退到更早的首次出现位置；新增条目总数不超过 `AD_DETECT_MAX_IMAGES_PER_BUNDLE`。
 *
 * @param candidates 待下载候选列表。
 * @param seenByKey 去重索引表。
 * @param candidate 当前视觉候选。
 */
function registerPendingMediaCandidate(
  candidates: PendingMediaCandidate[],
  seenByKey: Map<string, PendingMediaCandidate>,
  candidate: PendingMediaCandidate
): void {
  const existing: PendingMediaCandidate | undefined = seenByKey.get(candidate.uniqueKey);
  if (existing !== undefined) {
    if (candidate.isDirect) existing.isDirect = true;
    if (candidate.orderEntryIndex < existing.orderEntryIndex) {
      existing.orderEntryIndex = candidate.orderEntryIndex;
      existing.orderSlotIndex = candidate.orderSlotIndex;
    }
    return;
  }
  if (candidates.length >= AD_DETECT_MAX_IMAGES_PER_BUNDLE) return;
  candidates.push(candidate);
  seenByKey.set(candidate.uniqueKey, candidate);
}

/** `collectEntryMediaCandidates` 登记单条候选消息全部视觉源的入参。 */
interface CollectEntryMediaCandidatesParams {
  /** 当前处理的候选条目。 */
  readonly entry: AdCandidateEntry;
  /** 该条目在 `judged` 中的下标。 */
  readonly entryIndex: number;
  /** 该条目是否属于未检条目（`entry.seq > checkedSeq`）。 */
  readonly hasUnchecked: boolean;
  /** 已解析的自定义表情元数据映射表；无自定义表情时为 `undefined`。 */
  readonly customEmojiMeta: ReadonlyMap<string, CachedCustomEmojiMeta> | undefined;
  /** 待下载候选列表。 */
  readonly candidates: PendingMediaCandidate[];
  /** 去重索引表。 */
  readonly seenByKey: Map<string, PendingMediaCandidate>;
}

/**
 * 抽取单条候选条目中的普通图片、贴纸与自定义表情视觉源并登记至候选列表。
 *
 * @param params 条目、位置信息、自定义表情元数据与目标候选容器。
 */
function collectEntryMediaCandidates({
  entry,
  entryIndex,
  hasUnchecked,
  customEmojiMeta,
  candidates,
  seenByKey,
}: CollectEntryMediaCandidatesParams): void {
  const isDirect: boolean = !entry.isForwarded;
  if (entry.imageFileId !== undefined) {
    registerPendingMediaCandidate(candidates, seenByKey, {
      uniqueKey: `photo:${entry.imageFileUniqueId ?? entry.imageFileId}`,
      kind: "photo",
      fileId: entry.imageFileId,
      packName: undefined,
      hasUnchecked,
      orderEntryIndex: entryIndex,
      orderSlotIndex: 0,
      isDirect,
    });
  }
  if (entry.stickerFileId !== undefined) {
    registerPendingMediaCandidate(candidates, seenByKey, {
      uniqueKey: `sticker:${entry.stickerFileUniqueId ?? entry.stickerFileId}`,
      kind: "sticker",
      fileId: entry.stickerFileId,
      packName: entry.stickerSetName,
      hasUnchecked,
      orderEntryIndex: entryIndex,
      orderSlotIndex: 1,
      isDirect,
    });
  }
  if (entry.customEmojiIds !== undefined && customEmojiMeta !== undefined) {
    for (let emojiIndex: number = 0; emojiIndex < entry.customEmojiIds.length; emojiIndex++) {
      const meta: CachedCustomEmojiMeta | undefined =
        customEmojiMeta.get(entry.customEmojiIds[emojiIndex]!);
      if (meta === undefined || meta.visionFileId === null) continue;
      registerPendingMediaCandidate(candidates, seenByKey, {
        uniqueKey: `custom_emoji:${meta.fileUniqueId ?? meta.visionFileId}`,
        kind: "custom_emoji",
        fileId: meta.visionFileId,
        packName: meta.setName ?? undefined,
        hasUnchecked,
        orderEntryIndex: entryIndex,
        orderSlotIndex: 2 + emojiIndex,
        isDirect,
      });
    }
  }
}

/**
 * 按条目首次出现时间顺序比较两条待下载视觉候选。
 *
 * @param left 左侧视觉候选。
 * @param right 右侧视觉候选。
 * @returns 负数表示 `left` 排在前面，正数表示 `right` 排在前面，0 表示同位。
 */
function comparePendingCandidateOrder(
  left: PendingMediaCandidate,
  right: PendingMediaCandidate
): number {
  return left.orderEntryIndex - right.orderEntryIndex || left.orderSlotIndex - right.orderSlotIndex;
}

/**
 * 通过主线程下载边界拉取单条视觉素材并转码为 JPEG/PNG，单条失败时记录 warning 并返回 `null`。
 *
 * @param bundle 待检消息束（用于日志上下文）。
 * @param candidate 待下载的视觉候选。
 * @returns 规范化后的视觉图片；停机、下载失败、格式不支持或超限时返回 `null`。
 */
async function downloadAndPrepareMedia(
  bundle: AdMessageBundle,
  candidate: PendingMediaCandidate
): Promise<VisionImage | null> {
  if (adDetectStopping.current) return null;
  try {
    const download: TelegramWorkerDownloadFileResult = await downloadTelegramFileFromMain({
      fileId: candidate.fileId,
      purpose: "vision",
    });
    if (download.status !== "ok") {
      if (!adDetectStopping.current) {
        logger.warn("Ad detection skipped media attachment because Telegram download failed.", {
          chatId: bundle.chatId,
          senderId: bundle.senderId,
          kind: candidate.kind,
          status: download.status,
        });
      }
      return null;
    }
    const image: VisionImage | null = await prepareVisionImage(download.bytes);
    if (image === null) {
      logger.warn("Ad detection skipped media attachment with unsupported or unreadable image format.", {
        chatId: bundle.chatId,
        senderId: bundle.senderId,
        kind: candidate.kind,
      });
      return null;
    }
    if (image.bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.warn("Ad detection skipped prepared vision image exceeding size limit.", {
        chatId: bundle.chatId,
        senderId: bundle.senderId,
        kind: candidate.kind,
        bytes: image.bytes.byteLength,
        maxBytes: MEDIA_MAX_DOWNLOAD_BYTES,
      });
      return null;
    }
    return image;
  } catch (error: unknown) {
    if (!adDetectStopping.current) {
      logger.warn(
        "Ad detection failed to download or prepare media attachment:",
        { chatId: bundle.chatId, senderId: bundle.senderId, kind: candidate.kind },
        error
      );
    }
    return null;
  }
}

/**
 * 按 `MEDIA_MAX_DOWNLOAD_BYTES` 累积字节上限筛选可装入本次模型请求的视觉图片：
 * 先按时间顺序计入未检条目已加载图片，再按新到旧逆序用已判上下文图片补齐剩余预算，
 * 超出累积上限的图片记录 warning 并跳过。
 *
 * @param bundle 待检消息束（用于超限跳过日志上下文）。
 * @param pending 已按时间顺序排好的待下载候选列表。
 * @param settled 与 `pending` 一一对应的下载与转码结算结果。
 * @returns 与 `pending` 等长的图片数组，跳过或失败的位置为 `null`。
 */
function selectBudgetedImages(
  bundle: AdMessageBundle,
  pending: readonly PendingMediaCandidate[],
  settled: readonly PromiseSettledResult<VisionImage | null>[]
): (VisionImage | null)[] {
  const accepted: (VisionImage | null)[] = new Array<VisionImage | null>(pending.length).fill(null);
  let totalBytes: number = 0;

  function tryAccept(index: number): void {
    const result: PromiseSettledResult<VisionImage | null> = settled[index]!;
    if (result.status !== "fulfilled" || result.value === null) return;
    const candidate: PendingMediaCandidate = pending[index]!;
    const bytes: number = result.value.bytes.byteLength;
    if (totalBytes + bytes > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.warn("Ad detection skipped media attachment exceeding cumulative bundle size limit.", {
        chatId: bundle.chatId,
        senderId: bundle.senderId,
        kind: candidate.kind,
        bytes,
        totalBytes,
        maxBytes: MEDIA_MAX_DOWNLOAD_BYTES,
      });
      return;
    }
    totalBytes += bytes;
    accepted[index] = result.value;
  }

  for (let index: number = 0; index < pending.length; index++) {
    if (pending[index]!.hasUnchecked) tryAccept(index);
  }
  for (let index: number = pending.length - 1; index >= 0; index--) {
    if (!pending[index]!.hasUnchecked) tryAccept(index);
  }
  return accepted;
}

/**
 * 从已加载的视觉附件列表构造单份切片，并提取满足 `STICKER_PACK_NAME_PATTERN` 的去重包名候选。
 *
 * @param attachments 已加载完成的视觉附件列表。
 * @returns 包含附件与包名候选的只读切片。
 */
function buildMediaSlice(attachments: readonly AdDetectMediaAttachment[]): AdBundleMediaSlice {
  const stickerPackCandidates: string[] = [];
  const seenStickerPacks: Set<string> = new Set<string>();
  const emojiPackCandidates: string[] = [];
  const seenEmojiPacks: Set<string> = new Set<string>();
  for (const attachment of attachments) {
    const packName: string | undefined = attachment.packName;
    if (packName === undefined || !STICKER_PACK_NAME_PATTERN.test(packName)) continue;
    if (attachment.kind === "sticker") {
      if (!seenStickerPacks.has(packName)) {
        seenStickerPacks.add(packName);
        stickerPackCandidates.push(packName);
      }
    } else if (attachment.kind === "custom_emoji" && !seenEmojiPacks.has(packName)) {
      seenEmojiPacks.add(packName);
      emojiPackCandidates.push(packName);
    }
  }
  return { attachments, stickerPackCandidates, emojiPackCandidates };
}

/**
 * 合并两份已解析的自定义表情元数据只读映射表；首表缺省时直接返回新表。
 *
 * @param existing 已解析的映射表（可能为 `undefined`）。
 * @param extra 新补充解析的映射表。
 * @returns 合并后的自定义表情元数据只读映射表。
 */
function mergeCustomEmojiMeta(
  existing: ReadonlyMap<string, CachedCustomEmojiMeta> | undefined,
  extra: ReadonlyMap<string, CachedCustomEmojiMeta>
): ReadonlyMap<string, CachedCustomEmojiMeta> {
  if (existing === undefined) return extra;
  const merged: Map<string, CachedCustomEmojiMeta> = new Map<string, CachedCustomEmojiMeta>(existing);
  for (const [id, meta] of extra) merged.set(id, meta);
  return merged;
}

/**
 * 解析并并发下载本轮送检消息束的多模态视觉附件（普通图片、贴纸、自定义表情）：
 * 先选未检条目再按新到旧回填已判上下文，无未检文本且未选出任何未检候选时立即短路；
 * 下载完成后按累积字节上限（优先保留未检附件）生成按时间顺序排列的整串与直发切片。
 *
 * @param params 消息束、入选条目快照、是否存在未检文本及是否跳过自定义表情联网查询。
 * @returns 整串与发送者本人直发两份多模态切片，以及是否至少加载了一张未检附件。
 */
export async function resolveAdBundleMedia({
  bundle,
  judged,
  hasUncheckedText,
  skipCustomEmojiNetworkQuery = false,
}: ResolveAdBundleMediaParams): Promise<ResolvedAdBundleMedia> {
  const checkedSeq: number = bundle.checkedSeq;
  const initialEmojiIds: string[] = collectCustomEmojiIds(
    judged,
    hasUncheckedText ? undefined : { checkedSeq, unchecked: true }
  );
  let customEmojiMeta: ReadonlyMap<string, CachedCustomEmojiMeta> | undefined =
    initialEmojiIds.length > 0
      ? await resolveCustomEmojiMetadata(bundle, initialEmojiIds, skipCustomEmojiNetworkQuery)
      : undefined;

  const pending: PendingMediaCandidate[] = [];
  const seenByKey: Map<string, PendingMediaCandidate> = new Map<string, PendingMediaCandidate>();
  // Pass 1：按时间顺序优先选取未检条目（seq > checkedSeq）的视觉候选。
  for (let entryIndex: number = 0; entryIndex < judged.length; entryIndex++) {
    const entry: AdCandidateEntry = judged[entryIndex]!;
    if (entry.seq <= checkedSeq) continue;
    collectEntryMediaCandidates({
      entry,
      entryIndex,
      hasUnchecked: true,
      customEmojiMeta,
      candidates: pending,
      seenByKey,
    });
  }
  if (!hasUncheckedText && pending.length === 0) return EMPTY_RESOLVED_AD_BUNDLE_MEDIA;

  if (!hasUncheckedText) {
    const contextEmojiIds: string[] = collectCustomEmojiIds(judged, {
      checkedSeq,
      unchecked: false,
      exclude: customEmojiMeta,
    });
    if (contextEmojiIds.length > 0) {
      const contextMeta: ReadonlyMap<string, CachedCustomEmojiMeta> =
        await resolveCustomEmojiMetadata(bundle, contextEmojiIds, skipCustomEmojiNetworkQuery);
      customEmojiMeta = mergeCustomEmojiMeta(customEmojiMeta, contextMeta);
    }
  }

  // Pass 2：按新到旧逆序用已判上下文（seq <= checkedSeq）补齐剩余名额，并向全条目透传 isDirect。
  for (let entryIndex: number = judged.length - 1; entryIndex >= 0; entryIndex--) {
    const entry: AdCandidateEntry = judged[entryIndex]!;
    if (entry.seq > checkedSeq) continue;
    collectEntryMediaCandidates({
      entry,
      entryIndex,
      hasUnchecked: false,
      customEmojiMeta,
      candidates: pending,
      seenByKey,
    });
  }
  if (pending.length === 0) return EMPTY_RESOLVED_AD_BUNDLE_MEDIA;
  pending.sort(comparePendingCandidateOrder);

  const downloads: Promise<VisionImage | null>[] = [];
  for (const candidate of pending) {
    downloads.push(downloadAndPrepareMedia(bundle, candidate));
  }
  const settled: readonly PromiseSettledResult<VisionImage | null>[] =
    await Promise.allSettled(downloads);

  const budgetedImages: readonly (VisionImage | null)[] =
    selectBudgetedImages(bundle, pending, settled);
  const kindCounters: Record<AdDetectMediaKind, number> = { photo: 0, sticker: 0, custom_emoji: 0 };
  const combinedAttachments: AdDetectMediaAttachment[] = [];
  const directAttachments: AdDetectMediaAttachment[] = [];
  let hasUncheckedAttachments: boolean = false;
  for (let index: number = 0; index < pending.length; index++) {
    const image: VisionImage | null = budgetedImages[index] ?? null;
    if (image === null) continue;
    const candidate: PendingMediaCandidate = pending[index]!;
    kindCounters[candidate.kind]++;
    const attachment: AdDetectMediaAttachment = {
      id: `${candidate.kind}_${kindCounters[candidate.kind]}`,
      kind: candidate.kind,
      packName: candidate.packName,
      image,
    };
    combinedAttachments.push(attachment);
    if (candidate.isDirect) directAttachments.push(attachment);
    if (candidate.hasUnchecked) hasUncheckedAttachments = true;
  }
  if (combinedAttachments.length === 0) return EMPTY_RESOLVED_AD_BUNDLE_MEDIA;

  const combinedSlice: AdBundleMediaSlice = buildMediaSlice(combinedAttachments);
  const directSlice: AdBundleMediaSlice = directAttachments.length === 0
    ? EMPTY_RESOLVED_AD_BUNDLE_MEDIA.direct
    : directAttachments.length === combinedAttachments.length
      ? combinedSlice
      : buildMediaSlice(directAttachments);
  return { combined: combinedSlice, direct: directSlice, hasUncheckedAttachments };
}
