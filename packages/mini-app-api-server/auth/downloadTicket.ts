import { miniAppGalleryDownloadTickets } from "../../cache/main/miniApp";
import { MINI_APP_SHA256_HEX_PATTERN } from "../../consts/miniApp";
import {
  MINI_APP_DOWNLOAD_TICKET_TTL_MS,
  MINI_APP_SESSION_KEY_BYTES,
} from "../../consts/miniAppCrypto";
import type { MiniAppGalleryDownloadTicketRecord } from "../../types/miniApp/gallery";
import { generateMiniAppRandomHex } from "../libs/crypto";

/** `issueMiniAppGalleryDownloadTicket` 签发 60 秒一次性下载票据的入参。 */
export interface IssueMiniAppGalleryDownloadTicketOptions {
  /** 发起本次下载票据申请的活跃会话内部谱系标识。 */
  readonly sessionLineageId: string;
  /** 已通过校验的规范化图库文件名。 */
  readonly fileName: string;
  /** 下载响应 `Content-Disposition` 与前端下载提示共用的安全文件名。 */
  readonly downloadFileName: string;
  /** 当前毫秒时间戳（缺省取 `Date.now()`）。 */
  readonly nowMs?: number;
}

/** `resolveMiniAppGalleryDownloadTicket` 查找或消费下载票据的入参。 */
export interface ResolveMiniAppGalleryDownloadTicketOptions {
  /** URL 查询参数传入的候选 64 位十六进制下载票据。 */
  readonly ticket: string;
  /** 是否在校验通过后立即消费作废（`GET` 为 `true`，`HEAD` 探测为 `false`）。 */
  readonly consume: boolean;
  /** 可选的活跃会话有效性校验回调，按内部谱系标识确认绑定会话尚未过期或吊销。 */
  readonly isSessionActive?: (sessionLineageId: string) => boolean;
  /** 当前毫秒时间戳（缺省取 `Date.now()`）。 */
  readonly nowMs?: number;
}

/**
 * 清理主线程缓存中已超过 60 秒有效期的图库下载票据。
 * @param nowMs 当前毫秒时间戳。
 */
function purgeExpiredMiniAppGalleryDownloadTickets(nowMs: number): void {
  if (miniAppGalleryDownloadTickets.size === 0) {
    return;
  }
  miniAppGalleryDownloadTickets.forEach(
    (record: Readonly<MiniAppGalleryDownloadTicketRecord>, key: string): void => {
      if (record.expiresAt <= nowMs) {
        miniAppGalleryDownloadTickets.delete(key);
      }
    }
  );
}

/**
 * 为当前活跃会话谱系签发一枚 60 秒有效、仅限单次 `GET` 消费的图库文件下载票据。
 * @param options 绑定会话谱系标识、文件名与当前时间戳。
 * @returns 已写入有界缓存的下载票据记录。
 */
export function issueMiniAppGalleryDownloadTicket({
  sessionLineageId,
  fileName,
  downloadFileName,
  nowMs = Date.now(),
}: Readonly<IssueMiniAppGalleryDownloadTicketOptions>): Readonly<MiniAppGalleryDownloadTicketRecord> {
  purgeExpiredMiniAppGalleryDownloadTickets(nowMs);
  const ticket: string = generateMiniAppRandomHex(MINI_APP_SESSION_KEY_BYTES);
  const record: Readonly<MiniAppGalleryDownloadTicketRecord> = {
    ticket,
    sessionLineageId,
    fileName,
    downloadFileName,
    createdAt: nowMs,
    expiresAt: nowMs + MINI_APP_DOWNLOAD_TICKET_TTL_MS,
  };
  miniAppGalleryDownloadTickets.set(ticket, record);
  return record;
}

/**
 * 查找并按需一次性消费图库文件下载票据；若票据格式非法、已过期、或关联会话谱系已失效则返回 `null`。
 * @param options 票据字符串、是否消费标记及活跃会话谱系核验回调。
 * @returns 校验通过的票据记录，否则返回 `null`。
 */
export function resolveMiniAppGalleryDownloadTicket({
  ticket,
  consume,
  isSessionActive,
  nowMs = Date.now(),
}: Readonly<ResolveMiniAppGalleryDownloadTicketOptions>): Readonly<MiniAppGalleryDownloadTicketRecord> | null {
  purgeExpiredMiniAppGalleryDownloadTickets(nowMs);
  const trimmed: string = ticket.trim();
  if (!MINI_APP_SHA256_HEX_PATTERN.test(trimmed)) {
    return null;
  }
  const record: Readonly<MiniAppGalleryDownloadTicketRecord> | undefined =
    miniAppGalleryDownloadTickets.get(trimmed);
  if (record === undefined) {
    return null;
  }
  if (
    isSessionActive !== undefined &&
    !isSessionActive(record.sessionLineageId)
  ) {
    miniAppGalleryDownloadTickets.delete(trimmed);
    return null;
  }
  if (consume) {
    miniAppGalleryDownloadTickets.delete(trimmed);
  }
  return record;
}

/**
 * 吊销绑定在指定会话内部谱系标识上的全部未消费图库下载票据（登出、超时过期、验证器变更、IV 超限或满额淘汰后调用）。
 * @param sessionLineageId 待清理的会话内部谱系标识。
 */
export function revokeMiniAppGalleryDownloadTicketsForSession(
  sessionLineageId: string
): void {
  if (miniAppGalleryDownloadTickets.size === 0 || sessionLineageId.length === 0) {
    return;
  }
  miniAppGalleryDownloadTickets.forEach(
    (record: Readonly<MiniAppGalleryDownloadTicketRecord>, key: string): void => {
      if (record.sessionLineageId === sessionLineageId) {
        miniAppGalleryDownloadTickets.delete(key);
      }
    }
  );
}

/**
 * 在图库文件被删除时立即吊销全部指向该文件名的未消费下载票据。
 * @param fileName 被删除的规范化图库文件名。
 */
export function revokeMiniAppGalleryDownloadTicketsForFile(
  fileName: string
): void {
  if (miniAppGalleryDownloadTickets.size === 0 || fileName.length === 0) {
    return;
  }
  miniAppGalleryDownloadTickets.forEach(
    (record: Readonly<MiniAppGalleryDownloadTicketRecord>, key: string): void => {
      if (record.fileName === fileName) {
        miniAppGalleryDownloadTickets.delete(key);
      }
    }
  );
}

/**
 * 清空主线程内存中保存的全部 Mini App 图库下载票据（防爆破锁定或停机时调用）。
 */
export function clearAllMiniAppGalleryDownloadTickets(): void {
  miniAppGalleryDownloadTickets.clear();
}
