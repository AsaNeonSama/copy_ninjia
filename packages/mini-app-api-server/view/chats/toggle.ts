import { invalidateAiChat } from "../../../aiChat";
import {
  clearAdDetection,
  clearFloodControl,
  deactivateJoinGuardChat,
} from "../../../antiRaid";
import { miniAppBatchKickCompletedByChat } from "../../../cache/main/batchKick";
import {
  adDetectConfigReadiness,
  aiChatConfigReadiness,
  translateConfigReadiness,
} from "../../../config/readiness";
import { invalidateBotAdminStatus } from "../../../infra/botAdmin";
import { teardownChatRuntime } from "../../../infra/chatTeardown";
import { logger } from "../../../infra/logger";
import {
  disableChatStateSwitch,
  getActiveProxySendTarget,
  getChatState,
  getOrCreateChatState,
  persistChatState,
  purgeChatStateExceptLockdown,
} from "../../../infra/storage/stateStore";
import { stopTranslation } from "../../../translate/state";
import type { ChatState } from "../../../types/chatState";
import type { ConfigReadiness } from "../../../types/config";
import type {
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
} from "../../../types/miniApp";
import { getManagedChatDetail } from "./query";

/** `setManagedChatFeature` 的入参。 */
export interface SetManagedChatFeatureParams {
  /** 目标群聊 ID。 */
  readonly chatId: number;
  /** 待修改的功能开关项。 */
  readonly feature: MiniAppFeatureKey;
  /** 目标布尔状态。 */
  readonly enabled: boolean;
}

/**
 * 关闭群聊 `/init` 总开关并执行完整的运行时拆除与状态清理（与 `/init disable` 同序）。
 * @param chatId 目标群聊 ID。
 * @returns 拆除完成后的开关操作结果。
 */
async function disableChatInit(
  chatId: number
): Promise<Readonly<MiniAppFeatureToggleResult>> {
  miniAppBatchKickCompletedByChat.delete(chatId);
  disableChatStateSwitch(chatId, "isInitEnabled");
  invalidateBotAdminStatus(chatId);
  await persistChatState(chatId, "init toggled");

  let teardownFailed: boolean = false;
  try {
    await teardownChatRuntime(chatId, "explicitDisable");
    purgeChatStateExceptLockdown(chatId);
    await persistChatState(chatId, "init teardown settled");
  } catch (error: unknown) {
    teardownFailed = true;
    logger.error(
      `Failed to settle the chat runtime teardown for chat ${chatId}; ` +
      "the init gate is already persisted as disabled:",
      error
    );
  }

  return {
    ok: true,
    removedFromList: true,
    feature: "init",
    message: teardownFailed
      ? "CHAT_INIT_DISABLED_TEARDOWN_FAILED"
      : "CHAT_INIT_DISABLED",
    detail: null,
  };
}

/**
 * 校验开启某项依赖外部配置的群功能时配置是否就绪。
 * @param chatId 目标群聊 ID。
 * @param feature 功能键。
 * @param readiness 配置可用性结果。
 * @returns 配置未就绪时返回拒绝结果，已就绪时返回 `null`。
 */
async function checkFeatureReadiness(
  chatId: number,
  feature: MiniAppFeatureKey,
  readiness: ConfigReadiness
): Promise<Readonly<MiniAppFeatureToggleResult> | null> {
  if (readiness.ok) return null;
  return {
    ok: false,
    removedFromList: false,
    feature,
    configFile: readiness.failure.file,
    message: "FEATURE_CONFIG_NOT_READY",
    detail: await getManagedChatDetail(chatId),
  };
}

/**
 * 切换已 `/init` 群聊的指定功能开关（含 `/init`、`/ai_chat`、`/translate`、`/ad_detect`、`/flood_control`、`/antiraid`、`/send`）。
 * @param params 目标群 ID、功能键名与目标布尔值。
 * @returns 切换结果及最新群详细状态（若关闭 `/init` 则 `removedFromList: true` 且 `detail: null`）。
 */
export async function setManagedChatFeature({
  chatId,
  feature,
  enabled,
}: SetManagedChatFeatureParams): Promise<Readonly<MiniAppFeatureToggleResult>> {
  const current: Readonly<ChatState> = getChatState(chatId);
  if (current.isInitEnabled !== true) {
    return {
      ok: false,
      removedFromList: true,
      feature,
      message: "CHAT_NOT_INITIALIZED",
      detail: null,
    };
  }

  if (feature === "init") {
    if (enabled) {
      return {
        ok: true,
        removedFromList: false,
        feature: "init",
        message: "CHAT_INIT_ALREADY_ENABLED",
        detail: await getManagedChatDetail(chatId),
      };
    }
    return disableChatInit(chatId);
  }

  if (feature === "aiChat") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        await checkFeatureReadiness(chatId, "aiChat", aiChatConfigReadiness());
      if (refused !== null) return refused;
      if (getChatState(chatId).isInitEnabled !== true) {
        return {
          ok: false,
          removedFromList: true,
          feature: "aiChat",
          message: "CHAT_NOT_INITIALIZED",
          detail: null,
        };
      }
    }
    const state: ChatState = getOrCreateChatState(chatId);
    state.isAIChatEnabled = enabled;
    await persistChatState(chatId, "ai_chat toggled");
    if (!enabled) {
      try {
        await invalidateAiChat(chatId);
      } catch (error: unknown) {
        logger.error(
          `Failed to tear down the AI chat runtime of chat ${chatId}; ` +
          "the switch is already persisted as disabled:",
          error
        );
      }
    }
    return {
      ok: true,
      removedFromList: false,
      feature: "aiChat",
      message: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (feature === "translation") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        await checkFeatureReadiness(chatId, "translation", translateConfigReadiness());
      if (refused !== null) return refused;
      if (getChatState(chatId).isInitEnabled !== true) {
        return {
          ok: false,
          removedFromList: true,
          feature: "translation",
          message: "CHAT_NOT_INITIALIZED",
          detail: null,
        };
      }
      const state: ChatState = getOrCreateChatState(chatId);
      state.isTranslationEnabled = true;
      await persistChatState(chatId, "translation toggled");
    } else {
      const state: ChatState = getOrCreateChatState(chatId);
      state.isTranslationEnabled = false;
      await stopTranslation(chatId);
      if (getChatState(chatId).isInitEnabled === true) {
        await persistChatState(chatId, "translation toggled");
      }
    }
    return {
      ok: true,
      removedFromList: false,
      feature: "translation",
      message: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (feature === "adDetect") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        await checkFeatureReadiness(chatId, "adDetect", adDetectConfigReadiness());
      if (refused !== null) return refused;
      if (getChatState(chatId).isInitEnabled !== true) {
        return {
          ok: false,
          removedFromList: true,
          feature: "adDetect",
          message: "CHAT_NOT_INITIALIZED",
          detail: null,
        };
      }
    }
    const state: ChatState = getOrCreateChatState(chatId);
    state.isAdDetectEnabled = enabled;
    await persistChatState(chatId, "ad_detect toggled");
    if (!enabled) {
      try {
        clearAdDetection(chatId);
      } catch (error: unknown) {
        logger.error(
          `Failed to tear down the queued ad detection of chat ${chatId}; ` +
          "the switch is already persisted as disabled:",
          error
        );
      }
    }
    return {
      ok: true,
      removedFromList: false,
      feature: "adDetect",
      message: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (feature === "floodControl") {
    const state: ChatState = getOrCreateChatState(chatId);
    state.isFloodControlEnabled = enabled;
    await persistChatState(chatId, "flood_control toggled");
    if (!enabled) {
      try {
        clearFloodControl(chatId);
      } catch (error: unknown) {
        logger.error(
          `Failed to tear down the flood control runtime of chat ${chatId}; ` +
          "the switch is already persisted as disabled:",
          error
        );
      }
    }
    return {
      ok: true,
      removedFromList: false,
      feature: "floodControl",
      message: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (feature === "antiRaid") {
    const state: ChatState = getOrCreateChatState(chatId);
    state.isAntiRaidEnabled = enabled;
    await persistChatState(chatId, "antiraid toggled");
    if (!enabled) {
      try {
        deactivateJoinGuardChat(chatId);
      } catch (error: unknown) {
        logger.error(
          `Failed to tear down the join guard runtime of chat ${chatId}; ` +
          "the switch is already persisted as disabled:",
          error
        );
      }
    }
    return {
      ok: true,
      removedFromList: false,
      feature: "antiRaid",
      message: enabled ? "FEATURE_ENABLED" : "FEATURE_DISABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  if (enabled) {
    const previousTargetChatIds: number[] = [];
    let activeTargetChatId: number | undefined = getActiveProxySendTarget();
    while (activeTargetChatId !== undefined && activeTargetChatId !== chatId) {
      disableChatStateSwitch(activeTargetChatId, "isProxySendEnabled");
      previousTargetChatIds.push(activeTargetChatId);
      activeTargetChatId = getActiveProxySendTarget();
    }
    getOrCreateChatState(chatId).isProxySendEnabled = true;
    for (const previousChatId of previousTargetChatIds) {
      await persistChatState(previousChatId, "send finished");
    }
    if (getChatState(chatId).isInitEnabled !== true) {
      return {
        ok: false,
        removedFromList: true,
        feature: "proxySend",
        message: "CHAT_NOT_INITIALIZED",
        detail: null,
      };
    }
    await persistChatState(chatId, "send started");
    return {
      ok: true,
      removedFromList: false,
      feature: "proxySend",
      message: "PROXY_SEND_ENABLED",
      detail: await getManagedChatDetail(chatId),
    };
  }

  disableChatStateSwitch(chatId, "isProxySendEnabled");
  await persistChatState(chatId, "send finished");
  return {
    ok: true,
    removedFromList: false,
    feature: "proxySend",
    message: "PROXY_SEND_DISABLED",
    detail: await getManagedChatDetail(chatId),
  };
}
