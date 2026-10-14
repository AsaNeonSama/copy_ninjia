/** owner: workers/aiChat。贴纸包菜单记忆化状态（packages/aiChat/ai/tools/stickers.ts）。 */

import type { StickerPackCandidate } from "../../../../types/stickers/tools";

/**
 * 菜单输入的单调修订号。
 * 填充与更新：贴纸集合写入、目录 hydrate、目录剪枝或整包移除、对账结算及配置重载时调用 invalidateStickerMenu 递增。
 * 清理与重建：Worker 崩溃重启后从零开始；容量：固定为单个数值 holder，不设淘汰。
 */
export const stickerMenuRevision: { current: number } = { current: 0 };

/**
 * 最近一次构建的贴纸包菜单及其修订号；修订号匹配时由 buildStickerPackMenu 直接复用，不匹配时重建覆盖。
 * 重建：Worker 重启后从 null 开始；容量：固定为单个槽位。
 */
export const stickerMenuCache: {
  current: { revision: number; menu: readonly StickerPackCandidate[] } | null;
} = { current: null };

/**
 * 正在构建中的菜单 Promise 及其修订号；并发同版本请求复用同一 Promise，结算后置空。
 * 重建：Worker 重启后从 null 开始；容量：固定为单个槽位。
 */
export const stickerMenuInflight: {
  current: { revision: number; promise: Promise<readonly StickerPackCandidate[]> } | null;
} = { current: null };

/** 递增贴纸菜单修订号，使下次读取触发菜单重建。 */
export function invalidateStickerMenu(): void {
  stickerMenuRevision.current++;
}
