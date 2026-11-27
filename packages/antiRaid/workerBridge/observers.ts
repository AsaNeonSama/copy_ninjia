/**
 * Anti-Raid 桥接层的上游观察者绑定：将广告包黑名单变更、机器人自身群权限变更、群 teardown
 * 以及 Disk I/O 重生重放与验证落盘回执接入主线程镜像和 Worker 通道。
 */
import { chatIsSupergroupById } from "../../cache/main/antiRaid/chatKind";
import { blockedSenderChatDeleteDeniedChats } from "../../cache/main/antiRaid/blocklistGuard";
import { antiRaidRuntimeState } from "../../cache/main/antiRaid/proxy";
import {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
} from "../../cache/main/antiRaid/verificationMirror";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { registerAdPackBlacklistObserver } from "../../infra/adPackBlacklistStorage";
import {
  registerBotPermissionObserver,
} from "../../infra/botAdmin";
import { registerChatTeardown } from "../../infra/chatTeardownRegistry";
import { abandonsLockdown } from "../../libs/chatTeardown";
import { projectBotActionPermissions } from "../../libs/chatMember";
import {
  onDiskIORespawn,
  onDiskIOReply,
} from "../../infra/diskIO";
import { logger } from "../../infra/logger";
import type { AdPackBlacklistCounts } from "../../types/adPackBlacklist";
import type { AntiRaidWorkerMessage } from
  "../../types/antiRaid/protocol";
import type { ChatTeardownReason } from "../../types/chatTeardown";
import type {
  VerificationPersistedReply,
} from "../../types/diskIO/replies";
import type { DiskIORecoveryTransport } from "../../types/diskIO/messages";
import type {
  BotActionPermissions,
  BotChatPermissions,
} from "../../types/telegram";
import { settlePersistedVerificationDeferral } from "../verificationAttempts";
import { abandonEmergencyLockdownRecovery } from "../lockdownMirror";
import {
  recordVerificationPersisted,
  settleVerificationDeletePersisted,
} from "../verificationMirror";
import { buildAdPackBlacklistSyncMessage } from "./replay";

/** Anti-Raid 主线程观察者注册所需的代理能力。 */
export interface RegisterAntiRaidBridgeObserversOptions {
  /** 向当前代际 Anti-Raid Worker 尽力投递消息的入口。 */
  readonly post: (message: AntiRaidWorkerMessage) => boolean;
  /** 停用指定群的入群验证与封锁链路的回调。 */
  readonly deactivateChat: (
    chatId: number,
    cleanupVerificationMessages: boolean,
    abandonLockdown: boolean
  ) => void;
}

/**
 * 注册广告包黑名单、权限、群 teardown 与 Disk I/O 回执观察者。
 *
 * 调用一次后由各上游长期持有回调；Worker 重建只替换 post 背后的当前代际，
 * 不重复注册观察者。
 *
 * @param options 消息投递入口与群停用回调
 */
export function registerAntiRaidBridgeObservers({
  post,
  deactivateChat,
}: RegisterAntiRaidBridgeObserversOptions): void {
  registerAdPackBlacklistObserver((counts: Readonly<AdPackBlacklistCounts>): void => {
    if (!antiRaidRuntimeState.initialized) return;
    if (!post(buildAdPackBlacklistSyncMessage(counts))) {
      logger.error(
        "Anti-Raid Worker rejected the ad pack blacklist count update; relying on the next respawn to replay it."
      );
    }
  });

  registerBotPermissionObserver((
    chatId: number,
    permissions: BotChatPermissions | undefined
  ): void => {
    const workerPermissions: BotActionPermissions | undefined =
      permissions === undefined ? undefined : projectBotActionPermissions(permissions);
    post({
      type: "botPermissionsChanged",
      chatId,
      ...(workerPermissions !== undefined
        ? { permissions: workerPermissions }
        : {}),
    });
  });

  registerChatTeardown("antiRaid", (
    chatId: number,
    reason: ChatTeardownReason
  ): void => {
    const abandonLockdown: boolean = abandonsLockdown(reason);
    chatIsSupergroupById.delete(chatId);
    blockedSenderChatDeleteDeniedChats.delete(chatId);
    if (abandonLockdown) abandonEmergencyLockdownRecovery(chatId);
    deactivateChat(chatId, reason === "explicitDisable", abandonLockdown);
  });

  onDiskIORespawn(
    "Anti-Raid verification",
    DISK_IO_RESPAWN_PRIORITIES.ANTI_RAID_VERIFICATION,
    (transport: DiskIORecoveryTransport): boolean => {
      for (const record of activeVerificationSnapshots.values()) {
        if (!transport.post({
          type: "verificationUpsert",
          record,
          critical: true,
        })) return false;
      }
      for (const deletion of pendingVerificationDeletes.values()) {
        if (!transport.post({ type: "verificationDelete", ...deletion })) {
          return false;
        }
      }
      return true;
    }
  );

  onDiskIOReply("verificationPersisted", (reply: VerificationPersistedReply): void => {
    if (!reply.deleted) {
      if (!recordVerificationPersisted(reply.key, reply.generation, reply.revision)) return;
      if (settlePersistedVerificationDeferral(
        reply.key,
        reply.generation,
        reply.revision
      )) return;
      if (!post({
        type: "verificationPersisted",
        key: reply.key,
        generation: reply.generation,
        revision: reply.revision,
      })) {
        logger.error(
          "Anti-Raid Worker rejected the persisted verification receipt; relying on respawn replay to redeliver it.",
          { key: reply.key }
        );
      }
      return;
    }
    settleVerificationDeletePersisted(reply.key, reply.generation, reply.revision);
  });
}
