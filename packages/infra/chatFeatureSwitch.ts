/**
 * 群功能开关的统一落盘编排：按群开关命令（commands/superAdminToggle.ts 的 runChatToggleCommand）
 * 与 Mini App（mini-app-api-server/view/chats/toggle.ts）共用。
 */

import { CHAT_FEATURE_SWITCHES } from "../consts/chatFeatureSwitch";
import type {
  ChatFeatureSwitchDescriptor,
  ChatToggleFeature,
} from "../types/chatState";
import { logger } from "./logger";
import {
  disableChatStateSwitch,
  getChatState,
  getOrCreateChatState,
  persistChatState,
} from "./chatStateStorage";

/** `applyChatFeatureSwitch` 的入参。 */
export interface ApplyChatFeatureSwitchParams {
  /** 目标群 ID。 */
  readonly chatId: number;
  /** 切换的群功能。 */
  readonly feature: ChatToggleFeature;
  /** 目标布尔状态。 */
  readonly enabled: boolean;
  /** 关闭开关前必须完成的持久化前置操作；失败原样上抛，开关保持原值。 */
  readonly beforeDisable?: (chatId: number) => Promise<void>;
  /** 关闭方向的运行时拆除；省略表示没有需要就地收掉的运行时状态。 */
  readonly teardown?: (chatId: number) => void | Promise<void>;
}

/** `applyChatFeatureSwitch` 的结果。 */
export interface ChatFeatureSwitchOutcome {
  /** 写入之前该群这项开关是否已开。 */
  readonly wasEnabled: boolean;
  /** 关闭方向的运行时拆除是否抛错；开关此时已落盘。 */
  readonly teardownFailed: boolean;
}

/**
 * 关闭方向先跑关闭前置 → 置位并落盘 → 关闭方向尽力拆除运行时。
 *
 * 两处顺序是语义，调用方不得改动：
 * - 落盘先于运行时拆除；落盘失败原样上抛，那是 fatal durability failure，触发它的 update
 *   不能被确认（见 docs/cn/04-invariants.md）。
 * - 拆除异常只记日志、不外抛，以 `teardownFailed` 告知调用方；开关此时已落盘。
 *
 * 关闭方向经 `disableChatStateSwitch`，没有条目的群不新建。同状态重复执行仍会落盘并重跑拆除。
 * 开启前的配置检查与回执由调用方负责。
 * @param params 目标群、功能、目标状态与可选的关闭前置、运行时拆除。
 * @returns 写入前的开关状态与拆除是否失败。
 */
export async function applyChatFeatureSwitch({
  chatId,
  feature,
  enabled,
  beforeDisable,
  teardown,
}: ApplyChatFeatureSwitchParams): Promise<ChatFeatureSwitchOutcome> {
  const { switchKey, persistReason, runtimeLabel }: ChatFeatureSwitchDescriptor =
    CHAT_FEATURE_SWITCHES[feature];
  if (!enabled && beforeDisable !== undefined) await beforeDisable(chatId);

  const wasEnabled: boolean = getChatState(chatId)[switchKey] === true;
  if (enabled) getOrCreateChatState(chatId)[switchKey] = true;
  else disableChatStateSwitch(chatId, switchKey);
  await persistChatState(chatId, persistReason);

  let teardownFailed: boolean = false;
  if (!enabled && teardown !== undefined) {
    try {
      await teardown(chatId);
    } catch (error: unknown) {
      teardownFailed = true;
      logger.error(
        `Failed to tear down the ${runtimeLabel} of chat ${chatId}; ` +
        "the switch is already persisted as disabled:",
        error
      );
    }
  }
  return { wasEnabled, teardownFailed };
}
