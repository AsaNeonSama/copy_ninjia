/**
 * 通过主线程下载边界按 Telegram file_id 拉取语音消息音频字节并归一化容器 MIME。
 */

import {
  VOICE_DEFAULT_MIME,
  VOICE_MIME_TYPES,
} from "../../consts/aiChat/voice";
import { logger } from "../../infra/logger";
import { downloadTelegramFileFromMain } from "../../infra/telegram/workerClient";
import type { VoiceClip } from "../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../types/telegramWorker";

/** downloadTelegramVoice 的入参。 */
export interface DownloadTelegramVoiceParams {
  /** 待下载语音的 Telegram file_id。 */
  fileId: string;
  /** Telegram 声明的 mime_type；缺失或不在白名单内时回退到 VOICE_DEFAULT_MIME。 */
  declaredMime: string | undefined;
  /** 可选取消信号。 */
  signal?: AbortSignal;
}

/**
 * 将声明的语音 MIME 归一化到 VOICE_MIME_TYPES 白名单，未命中时返回 VOICE_DEFAULT_MIME。
 * @param declaredMime Telegram 声明的语音 MIME 类型。
 * @returns 归一化后的白名单语音 MIME 字符串。
 */
export function normalizeVoiceMime(declaredMime: string | undefined): string {
  if (declaredMime === undefined) return VOICE_DEFAULT_MIME;
  const normalized: string = declaredMime.trim().toLowerCase();
  return VOICE_MIME_TYPES.includes(normalized) ? normalized : VOICE_DEFAULT_MIME;
}

/**
 * 拉取单条语音的原始音频字节；失败时返回 null。
 * @param params 语音文件 ID、声明 MIME 与取消信号。
 * @returns 包含原始字节与归一化 MIME 的语音片段；下载失败或取消时返回 null。
 */
export async function downloadTelegramVoice({
  fileId,
  declaredMime,
  signal,
}: DownloadTelegramVoiceParams): Promise<VoiceClip | null> {
  try {
    const download: TelegramWorkerDownloadFileResult =
      await downloadTelegramFileFromMain({
        fileId,
        purpose: "voice",
        signal,
      });
    if (download.status !== "ok") {
      logger.error(`Chat voice download failed: ${download.status}.`);
      return null;
    }
    return {
      bytes: download.bytes,
      mime: normalizeVoiceMime(declaredMime),
    };
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error("Error loading chat voice:", error);
    return null;
  }
}
