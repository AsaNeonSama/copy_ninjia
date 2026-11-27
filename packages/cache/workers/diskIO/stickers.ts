/** owner: workers/diskIO。贴纸目录快照落盘缓冲状态（packages/workers/diskIO/stickerCatalogFiles.ts）。 */

import type { StickerCatalogPersistedReply } from "../../../types/diskIO/replies";

/** 贴纸包名到待写目录 JSON 快照的映射：仅在 `markStickerCatalogDirty` 写入待刷脏项，flush 完成后释放全部非 dirty 快照；启动只读恢复的干净快照不常驻此缓存，Worker 重建后从磁盘文件重新加载。 */
export const stickerCatalogCache: Map<string, string> = new Map();
/** 待写入磁盘的贴纸包名集合：markStickerCatalogDirty 登记，写入成功或 resetStickerCatalogCache 时移除；容量为 stickerCatalogCache 的待写子集，Worker 重建后由主线程未确认镜像重放。 */
export const dirtyStickerPacks: Set<string> = new Set();
/** 待写贴纸包名到最新 revision 的映射：markStickerCatalogDirty 覆盖，写入成功或 resetStickerCatalogCache 时删除；容量与 dirtyStickerPacks 同阶，Worker 重建后由主线程重放。 */
export const stickerCatalogRevisions: Map<string, number> = new Map();
/** 贴纸目录 durable 回执发送回调单例：Disk I/O Worker 启动时注入，isolate 销毁时释放；单例函数。 */
export const stickerCatalogPersistedNotifier: {
  current: (reply: StickerCatalogPersistedReply) => void;
} = { current: (): void => { /* Worker 入口在接收消息前注入。 */ } };
/** 贴纸目录批量刷盘定时器单例：首次标脏时创建，flush 或 resetStickerCatalogCache 时清除；Worker 重建后从 null 开始。 */
export const stickerFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/**
 * 写入指定贴纸包的最新目录快照与 revision 并标记为待刷盘。
 *
 * @param pack 贴纸包名称
 * @param snapshot 序列化后的贴纸目录 JSON 快照
 * @param revision 本次更新的修订号
 */
export function markStickerCatalogDirty(pack: string, snapshot: string, revision: number): void {
  stickerCatalogCache.set(pack, snapshot);
  dirtyStickerPacks.add(pack);
  stickerCatalogRevisions.set(pack, revision);
}

/** 取消定时刷盘 timer 并清空贴纸目录缓存、待写集合与 revision 映射。 */
export function resetStickerCatalogCache(): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
  stickerCatalogRevisions.clear();
}
