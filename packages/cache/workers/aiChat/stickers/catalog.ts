/** owner: workers/aiChat。白名单贴纸包目录与生成状态（packages/aiChat/ai/stickers/catalog.ts）。 */

import type { StickerCatalogEntry } from "../../../../types/stickers/catalog";

/**
 * packShortName -> (fileUniqueId -> 贴纸目录条目)。
 * 填充：从主线程镜像 hydrate 或由目录生成任务写入。
 * 清理：对账剪枝移除退包贴纸；贴纸包退出白名单且生成与上报完成后由 pruneStickerCatalogs 删除整包。
 * 重建：Worker 崩溃重启后接收主线程当前白名单目录镜像恢复并对账。
 * 容量：外层受配置白名单与在途包数约束，内层受贴纸包内贴纸数约束，不设 TTL 淘汰。
 */
export const catalogs: Map<string, Map<string, StickerCatalogEntry>> = new Map();

/**
 * packShortName -> AI 生成的整包简介（供 aiChat/ai/tools/stickers.ts 只读挑包，缺项表示尚未生成或生成失败）。
 * 填充：generatePackCatalog 或主线程镜像 hydrate 写入；清理、重建与容量同 catalogs。
 */
export const packSummaries: Map<string, string> = new Map();

/**
 * 待上报给主线程落盘的脏贴纸包名集合。
 * 填充：目录或整包简介更新时登记；清理：上报成功后清空；重建：Worker 重启后从空集合开始；容量：catalogs 的子集。
 */
export const dirtyPacks: Set<string> = new Set();

/**
 * packShortName -> (fileUniqueId -> 允许再次尝试生成的时间戳)。
 * 填充：贴纸描述生成失败时写入；清理：到期重试、贴纸移出包或整包移除时删除；重建：Worker 重启后从空表开始；容量：不超过 catalogs 同范围的贴纸数，按冷却到期清理。
 */
export const failedEntries: Map<string, Map<string, number>> = new Map();

/**
 * packShortName -> 后台目录生成任务 Promise。
 * 填充：发起目录生成时登记；清理：任务结算后立即删除；重建：Worker 重启后从空表开始；容量：每包至多一个在途任务。
 */
export const generatingPacks: Map<string, Promise<void>> = new Map();

/**
 * 贴纸目录维护重试的最近一次触发时间戳。
 * 填充：维护节拍触发不完整目录重试时更新；清理：测试重置或新值覆盖；重建：Worker 重启后归零；容量：固定为单个时间戳。
 */
export const stickerCatalogRetryState: { lastAttemptAt: number } = { lastAttemptAt: 0 };
