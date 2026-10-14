import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { logger } from "../../infra/logger";
import { downloadTelegramFileFromMain } from "../../infra/telegram/workerClient";
import { prepareVisionImage } from "../../infra/image";
import type { VisionImage } from "../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../types/telegramWorker";

export interface DownloadTelegramVisionImageParams {
  fileId: string;
  /** 诊断日志标签（不含用户文本、URL 或敏感凭据）。 */
  logLabel: string;
  signal?: AbortSignal;
}

/**
 * 通过主线程下载边界按 Telegram file_id 拉取图片，经 prepareVisionImage 规范化并校验 MEDIA_MAX_DOWNLOAD_BYTES 上限。
 */
export async function downloadTelegramVisionImage({
  fileId,
  logLabel,
  signal,
}: DownloadTelegramVisionImageParams): Promise<VisionImage | null> {
  try {
    const download: TelegramWorkerDownloadFileResult =
      await downloadTelegramFileFromMain({
        fileId,
        purpose: "vision",
        signal,
      });
    if (download.status !== "ok") {
      logger.error(`${logLabel} download failed: ${download.status}.`);
      return null;
    }

    const image: VisionImage | null = await prepareVisionImage(download.bytes);
    if (!image) {
      logger.error(`${logLabel} is an unsupported/unrecognized image format.`);
      return null;
    }
    if (image.bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.error(`Prepared ${logLabel} exceeded the size limit (${image.bytes.byteLength} bytes).`);
      return null;
    }
    return image;
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error(`Error loading ${logLabel}:`, error);
    return null;
  }
}
