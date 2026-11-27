/**
 * 广告检测配置与黑名单同步（Anti-Raid Worker 侧）：接收主线程投递的配置快照并刷新模型客户端与提示词缓存，以及同步广告包黑名单条数镜像。
 */
import {
  adDetectCapacitySaturated,
  adDetectPrompts,
  adDetectQueue,
  adDetectVisionSupport,
  adPackBlacklistCounts,
  queuedAdDetectKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  adDetectGoogleClientHolder,
  adDetectGoogleDecisionClientHolder,
} from "../../../cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../cache/workers/antiRaid/openai";
import { adDetectAnthropicClientHolder } from "../../../cache/workers/antiRaid/anthropic";
import { adoptAdDetectConfig } from "../../../config/adDetectConfig";
import { adoptAdDetectAgentConfig } from "../../../config/agent";
import type {
  AdPackBlacklistSyncMessage,
  AntiRaidAgentConfigMessage,
} from "../../../types/antiRaid/protocol";
import { clearPendingAdBundles } from "./queueState";

/**
 * 接管主线程投递的广告检测配置（初始化、Worker 重建与 `config/dynamic/` 热重载共用，本线程不直接读盘）：
 * - 更新 `agent.ad_detect` 快照、重置多模态能力探测缓存（`adDetectVisionSupport`）并清空各家 SDK 客户端缓存（在途判定继续持有旧客户端直至结算）；
 * - `adDetectConfig` 非空时替换广告检测部署配置快照（处罚设置与样本）并清空提示词缓存，为 `null` 时保持原快照不动；
 * - 若热重载使广告检测整体不可用（`adDetect === null` 或 `adDetectConfig === null`），清空 Worker 侧残留待检队列、在队键集合、待检消息束与容量饱和标记（不清除 `recentlyDisposedAdKeys`）。
 *
 * @param msg 主线程发来的广告检测与群风格配置消息。
 */
export function adoptAdDetectConfigMessage(msg: AntiRaidAgentConfigMessage): void {
  adoptAdDetectAgentConfig(msg.adDetect);
  adDetectGoogleClientHolder.current = null;
  adDetectGoogleDecisionClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectAnthropicClientHolder.current = null;
  adDetectVisionSupport.current = "unknown";
  if (msg.adDetectConfig !== null) {
    adoptAdDetectConfig(msg.adDetectConfig);
    adDetectPrompts.current = null;
  }
  if (msg.adDetect === null || msg.adDetectConfig === null) {
    adDetectQueue.clear();
    queuedAdDetectKeys.clear();
    clearPendingAdBundles();
    adDetectCapacitySaturated.current = false;
  }
}

/**
 * 接管主线程投递的广告包黑名单条数镜像（初始化、Worker 重建与主线程条数变化共用）。
 * 仅更新 `adPackBlacklistCounts`，绝不重置 AI SDK 客户端、提示词缓存或多模态探测状态。
 *
 * @param msg 主线程发来的广告包黑名单条数同步消息。
 */
export function adoptAdPackBlacklistSyncMessage(msg: AdPackBlacklistSyncMessage): void {
  adPackBlacklistCounts.sticker = msg.stickerCount;
  adPackBlacklistCounts.emoji = msg.emojiCount;
}
