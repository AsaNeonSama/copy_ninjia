import { latestStickerCatalogs } from "../cache/main/aiChat";
import {
  pendingStickerCatalogRevisions,
  stickerCatalogRevisionCounter,
} from "../cache/main/stickers";
import { stickerPacksForRecovery } from "../config/stickers";
import { onDiskIOReply, postDiskIO } from "../infra/diskIO";
import type { StickerCatalogPersistedReply } from "../types/diskIO/replies";

/**
 * 接收 AI Worker 上报的贴纸目录快照并转投 Disk I/O；即使贴纸包已移出白名单，也保留镜像直至最新 revision 落盘确认后再释放。
 * @param pack 贴纸包名称。
 * @param snapshot 序列化后的贴纸目录快照 JSON 字符串。
 */
export function mirrorStickerCatalog(pack: string, snapshot: string): void {
  const revision: number = ++stickerCatalogRevisionCounter.current;
  latestStickerCatalogs.set(pack, snapshot);
  pendingStickerCatalogRevisions.set(pack, revision);
  postDiskIO({ type: "stickerCatalog", pack, snapshot, revision });
}

/**
 * 按最新白名单回收已落盘确认且不再启用的贴纸包镜像；尚有待确认落盘 revision 的旧包继续保留以供 Disk I/O 崩溃重放。
 * @param activePacks 当前配置启用的贴纸包名称白名单。
 */
export function pruneStickerCatalogMirror(activePacks: readonly string[]): void {
  for (const pack of latestStickerCatalogs.keys()) {
    if (!activePacks.includes(pack) && !pendingStickerCatalogRevisions.has(pack)) {
      latestStickerCatalogs.delete(pack);
    }
  }
}

/**
 * 筛选出当前配置白名单内的贴纸目录快照供 AI Worker 重建恢复（待落盘的旧包仍保留在主线程镜像中供 Disk I/O 重放）。
 * @returns 当前配置白名单内的贴纸包目录快照映射。
 */
export function activeStickerCatalogs(): Map<string, string> {
  const catalogs: Map<string, string> = new Map();
  const activePacks: readonly string[] | null = stickerPacksForRecovery();
  if (activePacks === null) return catalogs;
  for (const [pack, snapshot] of latestStickerCatalogs) {
    if (activePacks.includes(pack)) catalogs.set(pack, snapshot);
  }
  return catalogs;
}

onDiskIOReply("stickerCatalogPersisted", (reply: StickerCatalogPersistedReply): void => {
  if (pendingStickerCatalogRevisions.get(reply.pack) !== reply.revision) return;
  pendingStickerCatalogRevisions.delete(reply.pack);
  if (!stickerPacksForRecovery()?.includes(reply.pack)) latestStickerCatalogs.delete(reply.pack);
});
