/** owner: workers/aiChat。贴纸包集合缓存（packages/aiChat/ai/stickers/sets.ts）。 */

import type { StickerSet } from "grammy/types";

/**
 * packShortName -> 拉取成功的 Telegram StickerSet。
 * 填充：getStickerSet 拉取成功时写入；清理：配置重载时移除退出白名单的包；重建：Worker 重启后从空表按需重拉；容量：受配置白名单包数约束，不设 TTL 淘汰。
 */
export const stickerSetCache: Map<string, StickerSet> = new Map();

/**
 * packShortName -> 拉取失败后允许再次重试的时间戳（间隔 STICKER_SET_FAILURE_RETRY_MS）。
 * 填充：拉取失败时写入；清理：到期重试或配置重载退出白名单时删除；重建：Worker 重启后从空表开始；容量：受配置白名单包数约束。
 */
export const failedPacks: Map<string, number> = new Map();

/**
 * packShortName -> 在途的 getStickerSet 请求 Promise。
 * 填充：首次发起拉取时登记；清理：请求结算后删除；重建：Worker 重启后从空表开始；容量：不超过当前白名单及轮换前在途的贴纸包数。
 */
export const inflightStickerSets: Map<string, Promise<StickerSet | null>> = new Map();
