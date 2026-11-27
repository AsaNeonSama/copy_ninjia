/**
 * Anti-Raid Worker 冷启动与崩溃重生时的状态重放构建器：推进 Worker 代际，并按固定顺序重放
 * 广告检测配置、广告包黑名单、机器人群权限、群类型、待验证与延后快照，以及开关已关闭群的残留守卫清理。
 */
import { chatIsSupergroupById } from "../../cache/main/antiRaid/chatKind";
import { antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  deferredVerificationRecords,
  pendingVerificationDeferrals,
} from "../../cache/main/antiRaid/verificationMirror";
import { adDetectAgentConfigSnapshot } from "../../config/agent";
import { getAdDetectConfig } from "../../config/adDetectConfig";
import { adDetectConfigReadiness } from "../../config/readiness";
import { botAtmosphere } from "../../infra/atmosphere";
import { getLogLevel } from "../../config/logLevel";
import { getTimeZone } from "../../config/time";
import { getAdPackBlacklistCounts } from "../../infra/adPackBlacklistStorage";
import { logger } from "../../infra/logger";
import { projectBotActionPermissions } from "../../libs/chatMember";
import {
  getChatState,
  getChatStateCache,
} from "../../infra/chatStateStorage";
import type { AdPackBlacklistCounts } from "../../types/adPackBlacklist";
import type {
  AdPackBlacklistSyncMessage,
  AdoptVerificationsMessage,
  AntiRaidWorkerMessage,
} from "../../types/antiRaid/protocol";
import type {
  DeferredVerificationRecord,
  VerificationSnapshot,
} from "../../types/antiRaid/verification";
import type { BotChatPermissions } from "../../types/telegram";
import { deleteDeferredVerificationsForChat } from "../verificationAttempts";

/**
 * 提升主线程代理代际；Worker 重生与进程冷启动共用同一入口。
 *
 * @returns 递增后的当前 Anti-Raid Worker 代际编号
 */
export function nextAntiRaidGeneration(): number {
  antiRaidRuntimeState.generation++;
  return antiRaidRuntimeState.generation;
}

/**
 * 构建当前代际的验证接管快照；已请求延后、尚在等待终态快照落盘回执的记录
 * （`pendingVerificationDeferrals`）直接归入延后列表，不重复列入活动集合。
 *
 * @param generation 将要接管快照的 Anti-Raid Worker 代际编号
 * @param resumePersistedTerminals 是否立即恢复已落盘的终态验证执行
 * @returns 发送给 Anti-Raid Worker 的验证接管消息载荷
 */
export function buildAdoptVerificationsMessage(
  generation: number,
  resumePersistedTerminals: boolean = false
): AdoptVerificationsMessage {
  const verifications: VerificationSnapshot[] = [];
  for (const [key, record] of activeVerificationSnapshots) {
    if (!pendingVerificationDeferrals.has(key)) verifications.push(record);
  }
  const deferredVerifications: DeferredVerificationRecord[] = [
    ...deferredVerificationRecords.values(),
    ...pendingVerificationDeferrals.values(),
  ];
  return {
    type: "adoptVerifications",
    generation,
    verifications,
    deferredVerifications,
    resumePersistedTerminals,
  };
}

/**
 * 把主线程当前生效的时区、氛围词表、广告检测能力配置与广告检测部署配置投给 Worker；
 * 重建时排在新 Worker 的业务消息之前。
 *
 * @param postTo 向目标 Anti-Raid Worker 投递消息的函数
 * @returns 配置消息成功投出时返回 true，否则返回 false
 */
export function replayAdDetectAgentConfig(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  return postTo({
    type: "agentConfig",
    timeZone: getTimeZone(),
    logLevel: getLogLevel(),
    atmosphere: botAtmosphere(),
    adDetect: adDetectAgentConfigSnapshot(),
    adDetectConfig: adDetectConfigReadiness().ok ? getAdDetectConfig() : null,
  });
}

/**
 * 将主线程广告包黑名单两类条数统计编码为发往 Anti-Raid Worker 的同步消息。
 *
 * @param counts 主线程当前的贴纸包与自定义表情包黑名单条数统计
 * @returns 广告包黑名单条数同步消息载荷
 */
export function buildAdPackBlacklistSyncMessage(
  counts: Readonly<AdPackBlacklistCounts>
): AdPackBlacklistSyncMessage {
  return {
    type: "adPackBlacklistSync",
    stickerCount: counts.sticker,
    emojiCount: counts.emoji,
  };
}

/**
 * 把主线程当前生效的广告包黑名单条数统计投给 Worker；
 * 初始化与 Worker 重建时排在业务消息之前。
 *
 * @param postTo 向目标 Anti-Raid Worker 投递消息的函数
 * @returns 黑名单条数同步消息成功投出时返回 true，否则返回 false
 */
export function replayAdPackBlacklists(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  return postTo(buildAdPackBlacklistSyncMessage(getAdPackBlacklistCounts()));
}

/**
 * 把机器人权限快照整表交给新 Worker；从未确证的群保持无条目。
 *
 * @param postTo 向目标 Anti-Raid Worker 投递消息的函数
 * @returns 全部已确证群的权限快照均成功投出时返回 true，否则返回 false
 */
export function replayBotPermissions(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  for (const [chatId, chatState] of getChatStateCache()) {
    const permissions: BotChatPermissions | undefined = chatState.botPermissions;
    if (permissions === undefined) continue;
    if (!postTo({
      type: "botPermissionsChanged",
      chatId,
      permissions: projectBotActionPermissions(permissions),
    })) return false;
  }
  return true;
}

/**
 * 把主线程已观测到的群类型整表交给新 Worker。
 *
 * @param postTo 向目标 Anti-Raid Worker 投递消息的函数
 * @returns 全部已观测群类型均成功投出时返回 true，否则返回 false
 */
export function replayChatKinds(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): boolean {
  for (const [chatId, isSupergroup] of chatIsSupergroupById) {
    if (!postTo({ type: "chatKind", chatId, isSupergroup })) return false;
  }
  return true;
}

/**
 * adopt 完成后清理开关已关群的残留入群守卫。
 *
 * Worker 先接管再收到 deactivate，按原 revision 协议产生 tombstone。
 *
 * @param postTo 向目标 Anti-Raid Worker 投递消息的函数
 */
export function purgeDisabledJoinGuards(
  postTo: (message: AntiRaidWorkerMessage) => boolean
): void {
  const purged: Set<number> = new Set();
  for (const record of activeVerificationSnapshots.values()) {
    if (purged.has(record.chatId)) continue;
    if (getChatState(record.chatId).isAntiRaidEnabled === true) continue;
    purged.add(record.chatId);
  }
  for (const record of deferredVerificationRecords.values()) {
    if (purged.has(record.chatId)) continue;
    if (getChatState(record.chatId).isAntiRaidEnabled === true) continue;
    purged.add(record.chatId);
  }
  for (const [chatId, chatState] of getChatStateCache()) {
    if (purged.has(chatId) || chatState.lockdown === undefined) continue;
    if (chatState.isAntiRaidEnabled === true) continue;
    purged.add(chatId);
  }
  if (purged.size === 0) return;
  for (const chatId of purged) {
    deleteDeferredVerificationsForChat(chatId);
    if (postTo({ type: "deactivateJoinGuard", chatId })) continue;
    logger.error(
      "Anti-Raid Worker rejected the join guard cleanup; relying on the next respawn to retry it.",
      { chatId }
    );
    return;
  }
  logger.info(
    "Cleared join guard runtime left over in chats whose /antiraid switch is off.",
    { purgedCount: purged.size, chatIds: [...purged] }
  );
}
