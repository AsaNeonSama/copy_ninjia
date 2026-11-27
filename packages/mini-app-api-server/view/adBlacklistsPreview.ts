import type { Sticker, StickerSet } from "grammy/types";
import {
  MINI_APP_AD_BLACKLIST_PREVIEW_BATCH_TIMEOUT_MS,
  MINI_APP_AD_BLACKLIST_PREVIEW_DOWNLOAD_CONCURRENCY,
  MINI_APP_AD_BLACKLIST_PREVIEW_FILE_DOWNLOAD_TIMEOUT_MS,
  MINI_APP_AD_BLACKLIST_PREVIEW_FILE_META_TIMEOUT_MS,
  MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES,
  MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_PREVIEW_SET_TIMEOUT_MS,
  MINI_APP_AD_BLACKLIST_STICKERSET_INVALID_PATTERN,
} from "../../consts/miniApp/features";
import { logger } from "../../infra/logger";
import { telegramApi } from "../../infra/telegram/client";
import { telegramErrorDetails } from "../../infra/telegram/errors";
import { downloadTelegramFileBytes } from "../../infra/telegram/fileDownload";
import { signalWithTimeout } from "../../libs/abortSignal";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../../libs/boundedSettledBatch";
import { sniffImageFormat } from "../../libs/imageFormat";
import type { SniffedImageFormat } from "../../libs/imageFormat";
import { telegramSignal } from "../../libs/telegramSignal";
import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistPreviewItem,
  MiniAppAdBlacklistPreviewResponse,
  MiniAppAdBlacklistStickerFormat,
} from "../../types/miniApp/adBlacklists";
import type { TelegramFileDownloadResult } from "../../types/telegram";

/** `fetchMiniAppAdBlacklistPackPreview` 查询贴纸/自定义表情包页内预览的入参。 */
export interface FetchMiniAppAdBlacklistPreviewParams {
  /** 请求所属内容黑名单种类（`"sticker"` 或 `"emoji"`）。 */
  readonly kind: MiniAppAdBlacklistKind;
  /** 已通过 `STICKER_PACK_NAME_PATTERN` 校验的包 short name。 */
  readonly pack: string;
  /** 起始偏移下标（非负整数，缺省为 `0`）。 */
  readonly offset?: number;
  /** 为 `true` 时仅调用 `getStickerSet` 返回包标题、总枚数与本页条目元数据（不下载缩略图），供前端先确认精确格数再渲染图片骨架。 */
  readonly metaOnly?: boolean;
  /** 可选请求取消信号，用于在客户端关闭弹窗或中断连接时及时中止 Telegram 拉取。 */
  readonly signal?: AbortSignal;
}

/** 贴纸/表情包预览视图返回结论（携带 HTTP 状态码与成功载荷或稳定错误码）。 */
export type AdBlacklistPreviewOutcome =
  | {
    readonly status: 200;
    readonly body: Readonly<MiniAppAdBlacklistPreviewResponse>;
  }
  | {
    readonly status: 404 | 503;
    readonly error:
      | "AD_BLACKLIST_PREVIEW_NOT_FOUND"
      | "AD_BLACKLIST_PREVIEW_UNAVAILABLE";
  };

/**
 * 将魔数嗅探出的图片格式映射为标准浏览器 `data:` URL MIME 类型；未知格式返回 `null`。
 *
 * @param format `sniffImageFormat` 识别出的图片格式。
 * @returns 合法图片 MIME 类型，或未知格式时的 `null`。
 */
function imageMimeTypeFromSniffed(format: SniffedImageFormat): string | null {
  switch (format) {
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "unknown":
      return null;
  }
}

/**
 * 归一化单枚贴纸的媒体形态标签。
 *
 * @param sticker Telegram 贴纸对象。
 * @returns `"video"`、`"animated"` 或 `"static"`。
 */
function resolveStickerFormat(
  sticker: Readonly<Sticker>
): MiniAppAdBlacklistStickerFormat {
  if (sticker.is_video) return "video";
  if (sticker.is_animated) return "animated";
  return "static";
}

/**
 * 为预览网格挑选单枚贴纸最轻量的静态图片 `file_id`：
 * 优先使用 Telegram 提供的 128px 缩略图（覆盖静态、TGS 动画与 WEBM 视频贴纸且体积小）；
 * 静态贴纸缺失缩略图时回退下载其自身 WebP 原图，动态/视频贴纸无缩略图时返回 `null`。
 *
 * @param sticker Telegram 贴纸对象。
 * @returns 可下载静态图片的 `file_id`，不可用时返回 `null`。
 */
function pickStickerPreviewFileId(sticker: Readonly<Sticker>): string | null {
  if (sticker.thumbnail !== undefined && sticker.thumbnail.file_id.length > 0) {
    return sticker.thumbnail.file_id;
  }
  if (!sticker.is_animated && !sticker.is_video && sticker.file_id.length > 0) {
    return sticker.file_id;
  }
  return null;
}

/**
 * 判断 Telegram 错误是否明确表示目标贴纸/表情包已失效或不存在（`400 STICKERSET_INVALID`）。
 *
 * @param error `getStickerSet` 抛出的异常值。
 * @returns 命中 `400 STICKERSET_INVALID` 时返回 `true`。
 */
function isStickerSetInvalidError(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  return (
    details?.errorCode === 400 &&
    MINI_APP_AD_BLACKLIST_STICKERSET_INVALID_PATTERN.test(details.description)
  );
}

/**
 * 构造单枚贴纸的纯元数据预览条目（不发起 `getFile` 与缩略图下载）。
 *
 * @param sticker Telegram 贴纸对象。
 * @param fileId 已解析的预览静态图 `file_id`（缺省时现算）。
 * @returns `imageDataUrl` 固定为 `null` 的元数据条目。
 */
function buildPreviewMetaItem(
  sticker: Readonly<Sticker>,
  fileId: string | null = pickStickerPreviewFileId(sticker)
): Readonly<MiniAppAdBlacklistPreviewItem> {
  return {
    fileUniqueId: sticker.file_unique_id,
    emoji:
      typeof sticker.emoji === "string" && sticker.emoji.length > 0
        ? sticker.emoji
        : null,
    format: resolveStickerFormat(sticker),
    hasImage: fileId !== null,
    imageDataUrl: null,
  };
}

/**
 * 下载单枚贴纸的静态预览图并经魔数校验编码为 `data:image/...;base64,...`；
 * 缺失可用静态图、下载超时、超限、非受支持图片魔数或任何异常均优雅降级为 `null`，不影响同批其余条目。
 *
 * @param sticker Telegram 贴纸对象。
 * @param batchSignal 本页批量下载共享的取消与总超时信号。
 * @returns 包含静态缩略图或 `null` 的预览条目。
 */
async function buildPreviewItem(
  sticker: Readonly<Sticker>,
  batchSignal: AbortSignal
): Promise<Readonly<MiniAppAdBlacklistPreviewItem>> {
  const fileId: string | null = pickStickerPreviewFileId(sticker);
  const metaItem: Readonly<MiniAppAdBlacklistPreviewItem> =
    buildPreviewMetaItem(sticker, fileId);
  if (fileId === null || batchSignal.aborted) {
    return metaItem;
  }

  try {
    const download: TelegramFileDownloadResult = await downloadTelegramFileBytes({
      fileId,
      maxBytes: MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES,
      metadataTimeoutMs: MINI_APP_AD_BLACKLIST_PREVIEW_FILE_META_TIMEOUT_MS,
      downloadTimeoutMs: MINI_APP_AD_BLACKLIST_PREVIEW_FILE_DOWNLOAD_TIMEOUT_MS,
      signal: batchSignal,
    });
    if (download.status !== "ok") {
      return metaItem;
    }
    const mimeType: string | null = imageMimeTypeFromSniffed(
      sniffImageFormat(download.bytes)
    );
    if (mimeType === null) {
      return metaItem;
    }
    return {
      fileUniqueId: metaItem.fileUniqueId,
      emoji: metaItem.emoji,
      format: metaItem.format,
      hasImage: metaItem.hasImage,
      imageDataUrl: `data:${mimeType};base64,${download.bytes.toBase64()}`,
    };
  } catch (_error: unknown) {
    return metaItem;
  }
}

/**
 * 通过 Bot API `getStickerSet` 拉取指定贴纸包或自定义表情包元数据，按 `offset` 分页切片；
 * `metaOnly: true` 时立即返回元数据与 `hasImage` 标志，`metaOnly: false` 时以有界并发下载本页缩略图内联返回。
 *
 * @param params 目标种类、short name、起始偏移、是否仅元数据与可选取消信号。
 * @returns 携带状态码的预览分页响应或错误码结论。
 */
export async function fetchMiniAppAdBlacklistPackPreview({
  kind,
  pack,
  offset = 0,
  metaOnly = false,
  signal,
}: Readonly<FetchMiniAppAdBlacklistPreviewParams>): Promise<
  Readonly<AdBlacklistPreviewOutcome>
> {
  const normalizedOffset: number = Math.max(0, Math.trunc(offset));
  const setSignal: AbortSignal = signalWithTimeout(
    signal,
    MINI_APP_AD_BLACKLIST_PREVIEW_SET_TIMEOUT_MS
  );
  let stickerSet: StickerSet;
  try {
    stickerSet = await telegramApi.getStickerSet(pack, telegramSignal(setSignal));
  } catch (error: unknown) {
    if (isStickerSetInvalidError(error)) {
      return {
        status: 404,
        error: "AD_BLACKLIST_PREVIEW_NOT_FOUND",
      };
    }
    if (signal?.aborted !== true) {
      logger.warn(
        "[MiniApp] Failed to fetch sticker set preview:",
        { kind, pack, offset: normalizedOffset },
        error
      );
    }
    return {
      status: 503,
      error: "AD_BLACKLIST_PREVIEW_UNAVAILABLE",
    };
  }

  const totalCount: number = stickerSet.stickers.length;
  const effectiveOffset: number = Math.min(normalizedOffset, totalCount);
  const pageStickers: readonly Sticker[] = stickerSet.stickers.slice(
    effectiveOffset,
    effectiveOffset + MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE
  );
  const nextOffset: number = effectiveOffset + pageStickers.length;
  const baseBody: Omit<MiniAppAdBlacklistPreviewResponse, "items"> = {
    kind,
    pack: stickerSet.name.length > 0 ? stickerSet.name : pack,
    title: stickerSet.title,
    stickerType: stickerSet.sticker_type,
    totalCount,
    offset: effectiveOffset,
    hasMore: nextOffset < totalCount,
    nextOffset,
  };

  if (
    metaOnly ||
    pageStickers.length === 0 ||
    !pageStickers.some(
      (sticker: Readonly<Sticker>): boolean =>
        pickStickerPreviewFileId(sticker) !== null
    )
  ) {
    return {
      status: 200,
      body: {
        ...baseBody,
        items: pageStickers.map(
          (sticker: Readonly<Sticker>): Readonly<MiniAppAdBlacklistPreviewItem> =>
            buildPreviewMetaItem(sticker)
        ),
      },
    };
  }

  const batchSignal: AbortSignal = signalWithTimeout(
    signal,
    MINI_APP_AD_BLACKLIST_PREVIEW_BATCH_TIMEOUT_MS
  );
  const settled: readonly BoundedBatchResult<
    Sticker,
    Readonly<MiniAppAdBlacklistPreviewItem>
  >[] = await runBoundedSettledBatch({
    items: pageStickers,
    maxConcurrent: MINI_APP_AD_BLACKLIST_PREVIEW_DOWNLOAD_CONCURRENCY,
    execute: ({
      item,
    }: BoundedBatchExecution<Sticker>): Promise<
      Readonly<MiniAppAdBlacklistPreviewItem>
    > => buildPreviewItem(item, batchSignal),
  });

  const items: MiniAppAdBlacklistPreviewItem[] = [];
  for (const entry of settled) {
    if (entry.status === "fulfilled") {
      items.push(entry.value);
    } else {
      items.push(buildPreviewMetaItem(entry.item));
    }
  }

  return {
    status: 200,
    body: {
      ...baseBody,
      items,
    },
  };
}
