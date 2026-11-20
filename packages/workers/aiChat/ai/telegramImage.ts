import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../consts/aiChat/media";
import { logger } from "../../../infra/logger";
import { downloadTelegramFileFromMain } from "../../../infra/telegram/workerClient";
import { prepareVisionImage } from "../../../infra/image";
import type { VisionImage } from "../../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../../types/telegramWorker";

/** downloadTelegramVisionImage 的入参。 */
export interface DownloadTelegramVisionImageParams {
  /** 待下载图片的 Telegram file_id。 */
  fileId: string;
  /** 诊断日志标签（不含用户文本、URL 或敏感凭据）。 */
  logLabel: string;
  /** 可选附加结构化诊断上下文。 */
  logContext?: Readonly<Record<string, unknown>>;
  /** 可选取消信号。 */
  signal?: AbortSignal;
}

/**
 * 通过主线程下载边界按 Telegram file_id 拉取图片，经 prepareVisionImage 规范化并校验 MEDIA_MAX_DOWNLOAD_BYTES 上限。
 * @param params 图片文件 ID、诊断日志标签、附加结构化上下文与取消信号。
 * @returns 规范化后的视觉图片载荷；下载失败、格式不识别、超限或取消时返回 null。
 */
export async function downloadTelegramVisionImage({
  fileId,
  logLabel,
  logContext,
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
      logger.error("Telegram image download failed.", {
        label: logLabel,
        ...logContext,
        status: download.status,
      });
      return null;
    }

    const image: VisionImage | null = await prepareVisionImage(download.bytes);
    if (!image) {
      logger.error("Downloaded Telegram image has an unsupported or unrecognized format.", {
        label: logLabel,
        ...logContext,
      });
      return null;
    }
    if (image.bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.error("Prepared Telegram image exceeded the size limit.", {
        label: logLabel,
        ...logContext,
        bytes: image.bytes.byteLength,
        maxBytes: MEDIA_MAX_DOWNLOAD_BYTES,
      });
      return null;
    }
    return image;
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error("Error loading Telegram image:", { label: logLabel, ...logContext }, error);
    return null;
  }
}
