/**
 * 贴纸目录快照的脏标记、定时合并落盘与持久化回执（Disk I/O Worker 侧）。
 */
import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  dirtyStickerPacks,
  markStickerCatalogDirty,
  resetStickerCatalogCache,
  stickerCatalogCache,
  stickerCatalogPersistedNotifier,
  stickerCatalogRevisions,
  stickerFlushState,
} from "../../cache/workers/diskIO/stickers";
import { flushDirtyEntries } from "./dirtyFlush";
import { retainOnlyKeys } from "../../libs/record";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";
import { writeStickerCatalogFile } from "./snapshotFiles";
import type { StickerCatalogFileDependencies } from "../../types/diskIO/snapshotOwners";
import type { StickerCatalogRecoveryInspection } from "./snapshotFiles";

/** Disk I/O owner 的只读贴纸目录写入句柄；整个 Worker 生命周期保持不变。 */
const STICKER_CATALOG_FILE_DEPENDENCIES: Readonly<StickerCatalogFileDependencies> = {
  write: writeStickerCatalogFile,
};

/** 按需注册贴纸目录定时落盘 timer，到点后经统一操作队列合并执行。 */
function scheduleStickerCatalogFlush(): void {
  armDiskIOFlushTimer(stickerFlushState, SNAPSHOT_FLUSH_INTERVAL_MS, flushStickerCatalogs);
}

/**
 * 跨域启动第二阶段：清空旧代待写缓冲与定时器，并将启动只读扫描得到的干净贴纸目录快照直接交回调用方回传主线程，
 * 不在 Disk I/O Worker 常驻干净副本。
 * @param inspection 启动只读扫描产出的贴纸目录探测结果。
 * @returns 供启动载荷回传的贴纸目录快照副本映射。
 */
export function adoptStickerCatalogSnapshots(
  inspection: StickerCatalogRecoveryInspection
): Map<string, string> {
  resetStickerCatalogCache();
  return new Map(inspection.snapshots);
}

/**
 * 覆盖式目录的 markDirty 边界。
 * @param pack 贴纸包短名称。
 * @param snapshot 序列化后的贴纸目录快照 JSON 文本。
 * @param revision 贴纸目录快照版本号。
 */
export function markStickerCatalogSnapshotDirty(pack: string, snapshot: string, revision: number): void {
  markStickerCatalogDirty(pack, snapshot, revision);
  scheduleStickerCatalogFlush();
}

/**
 * flush 边界：逐包写入，单包失败保留 dirty 并自动重排。
 * @param files 贴纸目录文件写入依赖；缺省为生产文件实现。
 * @returns 全部脏贴纸包均成功落盘时返回 true，仍有失败残留时返回 false。
 */
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
  retainOnlyKeys(stickerCatalogCache, dirtyStickerPacks);
  retainOnlyKeys(stickerCatalogRevisions, dirtyStickerPacks);
  if (dirtyStickerPacks.size > 0) scheduleStickerCatalogFlush();
  return dirtyStickerPacks.size === 0;
}
