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
import { disableManagedChat } from "../../../infra/botAdmin";
import { applyChatFeatureSwitch } from "../../../infra/chatFeatureSwitch";
import type { ChatFeatureSwitchOutcome } from "../../../infra/chatFeatureSwitch";
import {
  disableChatStateSwitch,
  getActiveProxySendTarget,
  getChatState,
  getOrCreateChatState,
  persistChatState,
} from "../../../infra/storage/stateStore";
import { stopTranslation } from "../../../translate/state";
import type { ChatToggleFeature } from "../../../types/chatState";
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
 * 关闭群聊 `/init` 总开关并执行完整的运行时拆除与状态清理（与 `/init disable` 共用 `disableManagedChat`）。
 * @param chatId 目标群聊 ID。
 * @returns 拆除完成后的开关操作结果。
 */
async function disableChatInit(
  chatId: number
): Promise<Readonly<MiniAppFeatureToggleResult>> {
  const teardownFailed: boolean = await disableManagedChat(chatId);
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
 * 开启该群功能前需要检查的部署配置可用性；无需检查时返回 `null`。
 * @param feature 群功能。
 * @returns 配置可用性结论，或 `null`。
 */
function enableReadinessOf(feature: ChatToggleFeature): ConfigReadiness | null {
  switch (feature) {
    case "aiChat":
      return aiChatConfigReadiness();
    case "translation":
      return translateConfigReadiness();
    case "adDetect":
      return adDetectConfigReadiness();
    case "floodControl":
    case "antiRaid":
      return null;
  }
}

/**
 * 该群功能关闭方向的运行时拆除，与对应命令（commands/aiChat.ts 等）同一份钩子；没有时返回 undefined。
 * @param feature 群功能。
 * @returns 运行时拆除函数，或 undefined。
 */
function teardownOf(feature: ChatToggleFeature): ((chatId: number) => void | Promise<void>) | undefined {
  switch (feature) {
    case "aiChat":
      return invalidateAiChat;
    case "adDetect":
      return clearAdDetection;
    case "floodControl":
      return clearFloodControl;
    case "antiRaid":
      return deactivateJoinGuardChat;
    case "translation":
      return undefined;
  }
}

/**
 * 切换群子功能（AI 闲聊、翻译、广告检测、防刷屏、入群守卫），与对应开关命令共用
 * infra/chatFeatureSwitch.ts 的 applyChatFeatureSwitch。
 *
 * 开启方向先查部署配置，未就绪时拒绝；入口的 `/init` 检查到置位之间不让出执行权。`/antiraid` 关闭时拆除失败
 * 回 `ANTI_RAID_DISABLED_TEARDOWN_FAILED`（开关已落盘，与命令的 teardownFailedText 同口径），其余功能
 * 拆除失败只记日志。
 * @param chatId 目标群 ID。
 * @param feature 群功能。
 * @param enabled 目标布尔状态。
 * @returns 切换结果及最新群详细状态。
 */
async function setChatToggleFeature(
  chatId: number,
  feature: ChatToggleFeature,
  enabled: boolean
): Promise<Readonly<MiniAppFeatureToggleResult>> {
  if (enabled) {
    const readiness: ConfigReadiness | null = enableReadinessOf(feature);
    if (readiness !== null && !readiness.ok) {
      return {
        ok: false,
        removedFromList: false,
        feature,
        configFile: readiness.failure.file,
        message: "FEATURE_CONFIG_NOT_READY",
        detail: await getManagedChatDetail(chatId),
      };
    }
  }
  const { teardownFailed }: ChatFeatureSwitchOutcome = await applyChatFeatureSwitch({
    chatId,
    feature,
    enabled,
    beforeDisable: feature === "translation" ? stopTranslation : undefined,
    teardown: teardownOf(feature),
  });
  return {
    ok: true,
    removedFromList: false,
    feature,
    message: enabled
      ? "FEATURE_ENABLED"
      : teardownFailed && feature === "antiRaid"
        ? "ANTI_RAID_DISABLED_TEARDOWN_FAILED"
        : "FEATURE_DISABLED",
    detail: await getManagedChatDetail(chatId),
  };
}

/**
 * 群未 `/init`（或已被关闭）时的拒绝结果。
 * @param feature 请求切换的功能键。
 * @returns 拒绝结果。
 */
function chatNotInitialized(feature: MiniAppFeatureKey): Readonly<MiniAppFeatureToggleResult> {
  return {
    ok: false,
    removedFromList: true,
    feature,
    message: "CHAT_NOT_INITIALIZED",
    detail: null,
  };
}

/**
 * 切换 `/send` 代发目标：开启时先关掉并落盘其它群的代发目标，再置位本群；为旧目标落盘期间本群
 * `/init` 被关闭时不再为本群落盘。
 * @param chatId 目标群 ID。
 * @param enabled 目标布尔状态。
 * @returns 切换结果及最新群详细状态。
 */
async function setProxySendTarget(
  chatId: number,
  enabled: boolean
): Promise<Readonly<MiniAppFeatureToggleResult>> {
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
    if (getChatState(chatId).isInitEnabled !== true) return chatNotInitialized("proxySend");
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
  if (getChatState(chatId).isInitEnabled !== true) return chatNotInitialized(feature);
  switch (feature) {
    case "init":
      if (!enabled) return disableChatInit(chatId);
      return {
        ok: true,
        removedFromList: false,
        feature: "init",
        message: "CHAT_INIT_ALREADY_ENABLED",
        detail: await getManagedChatDetail(chatId),
      };
    case "proxySend":
      return setProxySendTarget(chatId, enabled);
    default:
      return setChatToggleFeature(chatId, feature, enabled);
  }
}
