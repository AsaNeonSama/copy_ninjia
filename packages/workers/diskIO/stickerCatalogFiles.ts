import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  dirtyStickerPacks,
  hydrateStickerCatalogCache,
  markStickerCatalogDirty,
  stickerCatalogCache,
  stickerCatalogPersistedNotifier,
  stickerCatalogRevisions,
  stickerFlushState,
} from "../../cache/workers/diskIO/stickers";
import { flushDirtyEntries } from "./dirtyFlush";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";
import { writeStickerCatalogFile } from "./snapshotFiles";
import type { StickerCatalogFileDependencies } from "../../types/diskIO/snapshotOwners";
import type { StickerCatalogRecoveryInspection } from "./snapshotFiles";

/** Disk I/O owner 的只读贴纸目录写入句柄；整个 Worker 生命周期保持不变。 */
const STICKER_CATALOG_FILE_DEPENDENCIES: Readonly<StickerCatalogFileDependencies> = {
  write: writeStickerCatalogFile,
};

/** 执行定时到点的贴纸目录落盘。 */
function runScheduledStickerCatalogFlush(): void {
  flushStickerCatalogs();
}

/** 按需注册贴纸目录定时落盘 timer，到点后经统一操作队列合并执行。 */
function scheduleStickerCatalogFlush(): void {
  armDiskIOFlushTimer(
    stickerFlushState,
    SNAPSHOT_FLUSH_INTERVAL_MS,
    runScheduledStickerCatalogFlush
  );
}

/** 跨域启动第二阶段：全部领域 inspect 成功后整体发布到 owner 缓存。 */
export function adoptStickerCatalogSnapshots(
  inspection: StickerCatalogRecoveryInspection
): Map<string, string> {
  hydrateStickerCatalogCache(inspection.snapshots);
  return stickerCatalogCache;
}

/** 覆盖式目录的 markDirty 边界。 */
export function markStickerCatalogSnapshotDirty(pack: string, snapshot: string, revision: number): void {
  markStickerCatalogDirty(pack, snapshot, revision);
  scheduleStickerCatalogFlush();
}

/** flush 边界：逐包写入，单包失败保留 dirty 并自动重排。 */
export function flushStickerCatalogs(
  files: Readonly<StickerCatalogFileDependencies> = STICKER_CATALOG_FILE_DEPENDENCIES
): boolean {
  cancelDiskIOFlushTimer(stickerFlushState);
  flushDirtyEntries({
    dirty: dirtyStickerPacks,
    cache: stickerCatalogCache,
    write: (pack: string, snapshot: string): void => {
      files.write(pack, snapshot);
      stickerCatalogPersistedNotifier.current({
        type: "stickerCatalogPersisted",
        pack,
        revision: stickerCatalogRevisions.get(pack)!,
      });
    },
    describeFailure: (pack: string): string => `[diskIOWorker] failed to write sticker catalog for pack "${pack}":`,
  });
  for (const pack of stickerCatalogCache.keys()) {
    if (!dirtyStickerPacks.has(pack)) stickerCatalogCache.delete(pack);
  }
  for (const pack of stickerCatalogRevisions.keys()) {
    if (!dirtyStickerPacks.has(pack)) stickerCatalogRevisions.delete(pack);
  }
  if (dirtyStickerPacks.size > 0) scheduleStickerCatalogFlush();
  return dirtyStickerPacks.size === 0;
}
