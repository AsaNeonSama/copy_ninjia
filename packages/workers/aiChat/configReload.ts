import { ensureStickerCatalogs, pruneStickerCatalogs } from "../../aiChat/ai/stickers/catalog";
import { pruneStickerSets } from "../../aiChat/ai/stickers/sets";
import { refreshMood } from "../../aiChat/ai/mood";
import { reloadAgentDeploymentConfig } from "../../aiChat/provider";
import { invalidateStickerMenu } from "../../cache/workers/aiChat/stickers/menu";
import { aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { adoptMoodConfig } from "../../config/mood";
import { adoptStickerConfig } from "../../config/stickers";
import type { AiConfigReloadMessage } from "../../types/aiChat/protocol";

/**
 * 应用主线程热重载投递的部署配置：按变更领域替换本线程配置快照，刷新心情状态，
 * 失效并剪枝贴纸缓存，非停机排空期间启动白名单目录对账。跨线程保留与清理约束见 docs/cn/04-invariants.md。
 *
 * @param msg 主线程下发的配置热重载消息载荷
 */
export function applyAiChatConfigReload(msg: AiConfigReloadMessage): void {
  if (msg.agent !== undefined) reloadAgentDeploymentConfig(msg.agent);
  if (msg.mood !== undefined) {
    adoptMoodConfig(msg.mood);
    refreshMood();
  }
  if (msg.stickers !== undefined) {
    adoptStickerConfig(msg.stickers);
    invalidateStickerMenu();
    pruneStickerSets(msg.stickers.packs);
    pruneStickerCatalogs(msg.stickers.packs);
    if (!aiChatWorkerQuiescing.current) ensureStickerCatalogs(msg.stickers.packs);
  }
}
