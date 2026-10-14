import type { StickerSet } from "grammy/types";
import type { TelegramApi } from "../../../types/telegramWorker";
import { logger } from "../../../infra/logger";
import { telegramApi } from "../../../infra/telegram";
import { raceAbort } from "../../../libs/abortSignal";
import { telegramSignal } from "../../../libs/telegramSignal";
import { failedPacks, inflightStickerSets, stickerSetCache } from "../../../cache/workers/aiChat/stickers/sets";
import { STICKER_SET_FAILURE_RETRY_MS } from "../../../consts/aiChat/stickers";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";
import { getStickerConfig } from "../../../config/stickers";
import { isPendingWithin } from "../../../libs/clockWindow";

/** 配置轮换时释放退出白名单的正负缓存；在途请求仍服务已有等待者。 */
export function pruneStickerSets(activePacks: readonly string[]): void {
  for (const pack of stickerSetCache.keys()) {
    if (!activePacks.includes(pack)) stickerSetCache.delete(pack);
  }
  for (const pack of failedPacks.keys()) {
    if (!activePacks.includes(pack)) failedPacks.delete(pack);
  }
}

/** 本模块使用的 Telegram API 子集。 */
type StickerSetApi = Pick<TelegramApi, "getStickerSet">;

/**
 * 拉取或复用缓存的单个白名单贴纸集合（同包并发请求合并，底层请求绑定 Worker 生命周期信号，
 * 调用方 signal 仅取消自身等待）；失败时记录负缓存并返回 null。
 */
export async function getStickerSet(
  packName: string,
  api: StickerSetApi = telegramApi,
  signal?: AbortSignal
): Promise<StickerSet | null> {
  if (signal?.aborted === true) return null;
  const cached: StickerSet | undefined = stickerSetCache.get(packName);
  if (cached) return cached;
  const retryAt: number | undefined = failedPacks.get(packName);
  if (retryAt !== undefined) {
    if (isPendingWithin(retryAt, Date.now(), STICKER_SET_FAILURE_RETRY_MS)) return null;
    failedPacks.delete(packName);
  }

  const inflight: Promise<StickerSet | null> | undefined = inflightStickerSets.get(packName);
  if (inflight) return waitForStickerSet(inflight, signal);

  const workerSignal: AbortSignal = aiChatWorkerAbortController.current.signal;
  const request: Promise<StickerSet | null> = (async (): Promise<StickerSet | null> => {
    try {
      const set: StickerSet = await api.getStickerSet(packName, telegramSignal(workerSignal));
      if (workerSignal.aborted) return null;
      if (getStickerConfig().packs.includes(packName)) {
        stickerSetCache.set(packName, set);
        invalidateStickerMenu();
        failedPacks.delete(packName);
      }
      return set;
    } catch (error: unknown) {
      if (workerSignal.aborted) return null;
      logger.error(`Failed to fetch sticker set "${packName}":`, error);
      if (getStickerConfig().packs.includes(packName)) {
        failedPacks.set(packName, Date.now() + STICKER_SET_FAILURE_RETRY_MS);
      }
      return null;
    }
  })();
  inflightStickerSets.set(packName, request);
  const settleInflight = (): void => {
    if (inflightStickerSets.get(packName) === request) {
      inflightStickerSets.delete(packName);
    }
  };
  void request.then(settleInflight, settleInflight);
  return waitForStickerSet(request, signal);
}

/** 按调用方 signal 等待共享贴纸集合请求。 */
function waitForStickerSet(
  request: Promise<StickerSet | null>,
  signal?: AbortSignal
): Promise<StickerSet | null> {
  return raceAbort(request, { signal, cancelled: null, rejected: null });
}
