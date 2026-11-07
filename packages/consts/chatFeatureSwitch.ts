import type { ChatFeatureSwitchDescriptor, ChatToggleFeature } from "../types/chatState";

/**
 * 各群功能开关的字段名、落盘原因串与拆除日志名，供 infra/chatFeatureSwitch.ts 的
 * applyChatFeatureSwitch 查表；按群开关命令与 Mini App 共用同一份描述。键覆盖 ChatToggleFeature
 * 的全部成员，拆除与开启前的配置检查由调用方提供，不在表内。所属模块：infra/chatFeatureSwitch.ts。
 */
export const CHAT_FEATURE_SWITCHES: Readonly<Record<ChatToggleFeature, ChatFeatureSwitchDescriptor>> = {
  aiChat: { switchKey: "isAIChatEnabled", persistReason: "ai_chat toggled", runtimeLabel: "AI chat runtime" },
  translation: { switchKey: "isTranslationEnabled", persistReason: "translation toggled", runtimeLabel: "translation runtime" },
  adDetect: { switchKey: "isAdDetectEnabled", persistReason: "ad_detect toggled", runtimeLabel: "queued ad detection" },
  floodControl: { switchKey: "isFloodControlEnabled", persistReason: "flood_control toggled", runtimeLabel: "flood control runtime" },
  antiRaid: { switchKey: "isAntiRaidEnabled", persistReason: "antiraid toggled", runtimeLabel: "join guard runtime" },
};
