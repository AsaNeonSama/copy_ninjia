import type { AvatarDownloadResult, TelegramFileDownloadResult } from "../../../types/telegram";
import {
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
} from "../../../consts/telegram";
import { logger } from "../../logger";
import { downloadTelegramFileBytes } from "../fileDownload";

/**
 * 下载头像到有界内存（复用共享 Telegram 文件下载边界，`getFile` 与文件下载各自按 `AVATAR_FETCH_TIMEOUT_MS` 计时）：
 * 两段超时与文件服务器非成功响应按可重试处理，其余失败按确定性失败处理。
 * @param fileId 头像的 Telegram file_id。
 * @param targetId 仅用于错误日志诊断的目标用户或频道 ID。
 * @param signal 调用方的取消信号。
 * @returns 下载成功返回字节结果，失败返回按可否重试分类的状态对象。
 */
export async function downloadAvatarFile(
  fileId: string,
  targetId: number,
  signal?: AbortSignal
): Promise<AvatarDownloadResult> {
  const download: TelegramFileDownloadResult = await downloadTelegramFileBytes({
    fileId,
    maxBytes: AVATAR_MAX_DOWNLOAD_BYTES,
    metadataTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
    downloadTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
    signal,
  });
  switch (download.status) {
    case "ok":
      return download;
    case "missingPath":
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return { status: "permanent-failure" };
    case "metadataTimeout":
    case "downloadTimeout":
      logger.error(`Downloading the avatar file of target ${targetId} timed out (${download.status})`);
      return { status: "transient-failure" };
    case "httpError":
      logger.error(`Failed to download the avatar file of target ${targetId} (${download.httpStatus})`);
      return { status: "transient-failure" };
    case "tooLarge":
      logger.error(`Avatar file of target ${targetId} exceeded the download limit (${download.observedBytes} bytes)`);
      return { status: "permanent-failure" };
    case "empty":
      logger.error(`Avatar file of target ${targetId} downloaded empty`);
      return { status: "permanent-failure" };
  }
}
