/**
 * 广告检测配置同步（Anti-Raid Worker 侧）：接收主线程投递的配置快照并刷新模型客户端与提示词缓存。
 */
import {
  adDetectCapacitySaturated,
  adDetectPrompts,
  adDetectQueue,
  queuedAdDetectKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import { adDetectGoogleClientHolder } from "../../../cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../cache/workers/antiRaid/openai";
import { adDetectAnthropicClientHolder } from "../../../cache/workers/antiRaid/anthropic";
import { adoptAdDetectConfig } from "../../../config/adDetectConfig";
import { adoptAdDetectAgentConfig } from "../../../config/agent";
import type { AntiRaidAgentConfigMessage } from "../../../types/antiRaid/protocol";
import { clearPendingAdBundles } from "./queueState";

/**
 * 接管主线程投递的广告检测配置（初始化、Worker 重建与 `config/dynamic/` 热重载共用，本线程不直接读盘）：
 * - 更新 `agent.ad_detect` 快照并清空各家 SDK 客户端缓存（在途判定继续持有旧客户端直至结算）；
 * - `adDetectConfig` 非空时替换广告检测部署配置快照（样本与贴纸/表情黑名单）并清空提示词缓存，为 `null` 时保持原快照不动；
 * - 若热重载使广告检测整体不可用（`adDetect === null` 或 `adDetectConfig === null`），清空 Worker 侧残留待检队列、在队键集合、待检消息束与容量饱和标记（不清除 `recentlyDisposedAdKeys`）。
 *
 * @param msg 主线程发来的广告检测与群风格配置消息。
 */
export function adoptAdDetectConfigMessage(msg: AntiRaidAgentConfigMessage): void {
  adoptAdDetectAgentConfig(msg.adDetect);
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectAnthropicClientHolder.current = null;
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
