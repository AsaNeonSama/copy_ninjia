import { invalidateAiChat } from "../../../aiChat";
import {
  clearAdDetection,
  clearFloodControl,
  deactivateJoinGuardChat,
} from "../../../antiRaid";
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
    message: teardownFailed
      ? "已关闭 /init 总开关，但部分运行时状态清理失败。"
      : "已关闭该群 /init 总开关并从受管列表中移除。",
    detail: null,
  };
}

/**
 * 校验开启某项依赖外部配置的群功能时配置是否就绪。
 * @param chatId 目标群聊 ID。
 * @param label 功能中文名称。
 * @param readiness 配置可用性结果。
 * @returns 配置未就绪时返回拒绝结果，已就绪时返回 `null`。
 */
function checkFeatureReadiness(
  chatId: number,
  label: string,
  readiness: ConfigReadiness
): Readonly<MiniAppFeatureToggleResult> | null {
  if (readiness.ok) return null;
  return {
    ok: false,
    removedFromList: false,
    message: `${label}配置未就绪 (${readiness.failure.file})，无法开启。`,
    detail: getManagedChatDetail(chatId),
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
      message: "该群当前未开启 /init，已不在受管群列表中。",
      detail: null,
    };
  }

  if (feature === "init") {
    if (enabled) {
      return {
        ok: true,
        removedFromList: false,
        message: "该群已处于 /init 开启状态。",
        detail: getManagedChatDetail(chatId),
      };
    }
    return disableChatInit(chatId);
  }

  if (feature === "aiChat") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        checkFeatureReadiness(chatId, "AI 群聊", aiChatConfigReadiness());
      if (refused !== null) return refused;
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
      message: enabled ? "已开启 AI 群聊 (/ai_chat)。" : "已关闭 AI 群聊 (/ai_chat)。",
      detail: getManagedChatDetail(chatId),
    };
  }

  if (feature === "translation") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        checkFeatureReadiness(chatId, "自动翻译", translateConfigReadiness());
      if (refused !== null) return refused;
    } else {
      await stopTranslation(chatId);
    }
    const state: ChatState = getOrCreateChatState(chatId);
    state.isTranslationEnabled = enabled;
    await persistChatState(chatId, "translation toggled");
    return {
      ok: true,
      removedFromList: false,
      message: enabled ? "已开启自动翻译 (/translate)。" : "已关闭自动翻译 (/translate)。",
      detail: getManagedChatDetail(chatId),
    };
  }

  if (feature === "adDetect") {
    if (enabled) {
      const refused: Readonly<MiniAppFeatureToggleResult> | null =
        checkFeatureReadiness(chatId, "广告检测", adDetectConfigReadiness());
      if (refused !== null) return refused;
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
      message: enabled ? "已开启广告检测 (/ad_detect)。" : "已关闭广告检测 (/ad_detect)。",
      detail: getManagedChatDetail(chatId),
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
      message: enabled ? "已开启防刷屏禁言 (/flood_control)。" : "已关闭防刷屏禁言 (/flood_control)。",
      detail: getManagedChatDetail(chatId),
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
      message: enabled ? "已开启入群守卫 (/antiraid)。" : "已关闭入群守卫 (/antiraid)。",
      detail: getManagedChatDetail(chatId),
    };
  }

  if (enabled) {
    const activeTargetChatId: number | undefined = getActiveProxySendTarget();
    if (activeTargetChatId !== undefined && activeTargetChatId !== chatId) {
      disableChatStateSwitch(activeTargetChatId, "isProxySendEnabled");
      await persistChatState(activeTargetChatId, "send finished");
    }
    getOrCreateChatState(chatId).isProxySendEnabled = true;
    await persistChatState(chatId, "send started");
    return {
      ok: true,
      removedFromList: false,
      message: "已将该群设为私聊中转发送目标 (/send)。",
      detail: getManagedChatDetail(chatId),
    };
  }

  disableChatStateSwitch(chatId, "isProxySendEnabled");
  await persistChatState(chatId, "send finished");
  return {
    ok: true,
    removedFromList: false,
    message: "已停止该群的私聊中转发送 (/send finish)。",
    detail: getManagedChatDetail(chatId),
  };
}
