/** owner: main。贴纸目录落盘未确认 revision 与发号器状态（packages/infra/stickerCatalog.ts）。 */

/**
 * 贴纸包名到未确认落盘最新 revision 的映射：发布贴纸目录写入时覆盖，收到匹配 revision 的 durable 回执时删除；Disk I/O Worker 重建时与贴纸目录镜像一同重放（缺失表示无待确认写入，已移出配置的包镜像可释放）。
 * 容量与当前配置贴纸包及待确认历史包数同阶，不淘汰未确认条目；进程重启后从空表开始。
 */
export const pendingStickerCatalogRevisions: Map<string, number> = new Map();

/** 贴纸目录写入的单调递增 revision 发号器：每次发布自增，Worker 重建不重置，进程重启后从零开始；单例标量。 */
export const stickerCatalogRevisionCounter: { current: number } = { current: 0 };
