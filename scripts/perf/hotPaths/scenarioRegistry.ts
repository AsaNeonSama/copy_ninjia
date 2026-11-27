/** 热路径场景名到独立领域夹具的唯一注册表。 */

import {
  adEmptyMetadataScenario,
  adWireCloneScenario,
  createAdCapacityRejectScenario,
} from "./adDetectScenarios";
import { cooldownScenario } from "./cooldownScenarios";
import { storageFlushScenario } from "./storageFlushScenario";
import { verificationSnapshotScenario } from "./verificationSnapshotScenario";
import { boundedResponseScenario } from "./boundedResponseScenario";
import { wedMemberChatSwitchScenario, wedMemberScenario } from "./wedMemberScenarios";
import { registeredMiddlewareScenario } from "./registeredMiddlewareScenario";
import {
  floodWindowGrowthScenario,
  floodWindowHitScenario,
  floodWindowSteadyScenario,
} from "./floodScenarios";
import {
  createIdentityPermissionReadScenario,
} from "./identityScenarios";
import { createLuckReceiptFastPathScenario } from "./luckReceiptScenario";
import {
  aiMediaDirectTriggerScenario,
  incomingMessageSpineScenario,
  selfSentActiveScenario,
  selfSentEmptyScenario,
} from "./messageSpineScenarios";
import {
  aiActivityLruMissScenario,
  aiActivityScenario,
  boundedRollingBufferScenario,
  chatStateMapReadScenario,
  chatStateReadScenario,
  gagSpeakCounterScenario,
  joinTimestampWindowScenario,
  luckTierTableScenario,
  quotaTimestampWindowScenario,
  redactCleanLogScenario,
  senderMixedIdentityScenario,
  senderScenario,
} from "./scenarios";
import { createTemporaryAdBypassActivityScenario } from
  "./temporaryAdBypassScenario";
import {
  bufferedMessageBuildScenario,
  mentionFactsScenario,
  replyReferenceScenario,
  transcriptRenderScenario,
} from "./transcriptScenarios";
import { pendingVerificationLookupScenario } from "./verificationLookupScenario";
import {
  miniAppFrontendRenderScenario,
  miniAppStatusRouteScenario,
} from "./miniAppScenarios";
import type { Scenario, ScenarioName } from "./types";
import { base64PayloadScenario, replyAdmissionScenario, replyDeliveryScenario } from "./replyScenarios";
import { proxyTtsDetectScenario, voiceMessageEncodeScenario } from "./voiceScenarios";

/**
 * 热路径场景名到工厂函数的唯一注册表。`Record<ScenarioName, () => Scenario>` 在编译期与
 * `ScenarioName` 严格对齐（缺一或多一均报错），场景名解析与工厂分派共享同一定义。
 */
const SCENARIO_FACTORIES: Readonly<Record<ScenarioName, () => Scenario>> = {
  "cooldown-hit": (): Scenario => cooldownScenario("hit"),
  "cooldown-renew": (): Scenario => cooldownScenario("renew"),
  "cooldown-growth": (): Scenario => cooldownScenario("growth"),
  "cooldown-saturated": (): Scenario => cooldownScenario("saturated"),
  "cooldown-expiry": (): Scenario => cooldownScenario("expiry"),
  "reply-admission": (): Scenario => replyAdmissionScenario(),
  "reply-delivery-normal": (): Scenario => replyDeliveryScenario(false),
  "reply-delivery-capacity": (): Scenario => replyDeliveryScenario(true),
  "base64-normal": (): Scenario => base64PayloadScenario("normal"),
  "base64-large": (): Scenario => base64PayloadScenario("large"),
  "base64-head": (): Scenario => base64PayloadScenario("head"),
  "base64-tail": (): Scenario => base64PayloadScenario("tail"),
  "voice-message-encode": (): Scenario => voiceMessageEncodeScenario(),
  "proxy-tts-detect": (): Scenario => proxyTtsDetectScenario(),
  "storage-sqlite-flush": (): Scenario => storageFlushScenario(),
  "verification-snapshot": (): Scenario => verificationSnapshotScenario(false),
  "verification-snapshot-clone": (): Scenario => verificationSnapshotScenario(true),
  "pending-verification-lookup": (): Scenario => pendingVerificationLookupScenario(),
  "bounded-response-empty": (): Scenario => boundedResponseScenario("empty"),
  "bounded-response-tiny": (): Scenario => boundedResponseScenario("tiny"),
  "bounded-response-small": (): Scenario => boundedResponseScenario("small"),
  "bounded-response-normal": (): Scenario => boundedResponseScenario("normal"),
  "bounded-response-large": (): Scenario => boundedResponseScenario("large"),
  "wed-member-hit": (): Scenario => wedMemberScenario("hit"),
  "wed-member-growth": (): Scenario => wedMemberScenario("growth"),
  "wed-member-churn": (): Scenario => wedMemberScenario("churn"),
  "wed-member-chat-switch": (): Scenario => wedMemberChatSwitchScenario(),
  "registered-middleware": (): Scenario => registeredMiddlewareScenario(),
  "sender-no-username": (): Scenario => senderScenario(),
  "sender-stable-username": (): Scenario => senderScenario("Stable_User"),
  "sender-mixed-identity": (): Scenario => senderMixedIdentityScenario(),
  "luck-receipt-fast-path": (): Scenario => createLuckReceiptFastPathScenario(),
  "ai-activity-window": (): Scenario => aiActivityScenario(),
  "ai-activity-lru-miss": (): Scenario => aiActivityLruMissScenario(),
  "ad-empty-metadata": (): Scenario => adEmptyMetadataScenario(),
  "ad-wire-clone": (): Scenario => adWireCloneScenario(),
  "ad-capacity-reject": (): Scenario => createAdCapacityRejectScenario(),
  "identity-permission-read": (): Scenario => createIdentityPermissionReadScenario(),
  "temporary-whitelist-activity": (): Scenario => createTemporaryAdBypassActivityScenario(),
  "join-timestamp-window": (): Scenario => joinTimestampWindowScenario(),
  "quota-timestamp-window": (): Scenario => quotaTimestampWindowScenario(),
  "bounded-rolling-buffer": (): Scenario => boundedRollingBufferScenario(),
  "chat-state-read": (): Scenario => chatStateReadScenario(),
  "chat-state-map-read": (): Scenario => chatStateMapReadScenario(),
  "self-sent-empty": (): Scenario => selfSentEmptyScenario(),
  "self-sent-active": (): Scenario => selfSentActiveScenario(),
  "incoming-message-spine": (): Scenario => incomingMessageSpineScenario(),
  "ai-media-direct-trigger": (): Scenario => aiMediaDirectTriggerScenario(),
  "flood-window-hit": (): Scenario => floodWindowHitScenario(),
  "flood-window-growth": (): Scenario => floodWindowGrowthScenario(),
  "flood-window-steady": (): Scenario => floodWindowSteadyScenario(),
  "gag-speak-counter": (): Scenario => gagSpeakCounterScenario(),
  "buffered-message-build": (): Scenario => bufferedMessageBuildScenario(),
  "transcript-render": (): Scenario => transcriptRenderScenario(),
  "reply-reference": (): Scenario => replyReferenceScenario(),
  "mention-facts": (): Scenario => mentionFactsScenario(true),
  "mention-facts-plain": (): Scenario => mentionFactsScenario(false),
  "redact-clean-log": (): Scenario => redactCleanLogScenario(),
  "luck-tier-table": (): Scenario => luckTierTableScenario(),
  "mini-app-status-route": (): Scenario => miniAppStatusRouteScenario(),
  "mini-app-frontend-render": (): Scenario => miniAppFrontendRenderScenario(),
};

/** 全部已注册的热路径场景名只读列表，与 `ScenarioName` 严格一致。 */
export const REGISTERED_SCENARIO_NAMES: readonly ScenarioName[] = Object.keys(
  SCENARIO_FACTORIES
) as ScenarioName[];

/**
 * 判定给定字符串是否为已注册的热路径场景名称。
 *
 * @param value 待校验的命令行参数字符串。
 * @returns 已注册时返回 `true` 并收窄为 `ScenarioName`。
 */
export function isRegisteredScenarioName(value: string | undefined): value is ScenarioName {
  return value !== undefined && Object.hasOwn(SCENARIO_FACTORIES, value);
}

/**
 * 按稳定名称建立一份独立场景；每个子进程只调用一次。
 *
 * @param name 热路径场景名称
 * @returns 对应名称的热路径场景定义
 */
export function createScenario(name: ScenarioName): Scenario {
  return SCENARIO_FACTORIES[name]();
}
