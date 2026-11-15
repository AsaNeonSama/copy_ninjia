/**
 * 媒体输入能力支持度归约的效果解释器与状态写回边界（AI Chat Worker 侧）。
 * 状态转移逻辑在 `packages/states/mediaInputSupport.ts`，模态状态与单飞槽缓存在
 * `packages/cache/workers/aiChat/mediaInputSupport.ts`。
 */

import {
  getMediaInputState,
  replaceModalityState,
} from "../../cache/workers/aiChat/mediaInputSupport";
import { logger } from "../../infra/logger";
import { reduceMediaInputResult } from "../../states/mediaInputSupport";
import type {
  AiTextResult,
  MediaInputCapability,
} from "../../types/aiChat/provider";
import type {
  MediaInputEffect,
  MediaInputModalityState,
  MediaInputTransition,
} from "../../types/states/mediaInputSupport";

/**
 * 执行媒体输入状态转移产出的日志副作用。
 *
 * @param effect 状态转移产出的副作用描述
 */
function applyMediaInputEffect(effect: MediaInputEffect): void {
  switch (effect.kind) {
    case "logMisconfiguredMediaEndpoint":
      logger.error(
        `AI media ${effect.capability} input is disabled for this worker: the configured media endpoint reported ` +
        "that the model or API path does not exist (HTTP 404/405). Check the model and base_url of " +
        "$.agent.media in the agent configuration."
      );
      break;
  }
}

/** 单次媒体输入请求的结果归因参数。 */
export interface RecordMediaInputResultOptions {
  /** 媒体输入模态（`vision` 或 `voice`）。 */
  readonly capability: MediaInputCapability;
  /** 本次模型调用的业务结果。 */
  readonly result: AiTextResult;
  /** 发起本次调用时读取到的模态支持度状态快照（用于配置代次校验）。 */
  readonly attemptState: MediaInputModalityState;
  /** 当前毫秒时间戳；缺省时读取墙钟 `Date.now()`。 */
  readonly now?: number;
}

/**
 * 将单次媒体输入请求的结果归因到模态支持度状态机，执行日志副作用并在状态变化时写回缓存。
 *
 * @param options 媒体输入结果归因参数
 */
export function recordMediaInputResult({
  capability,
  result,
  attemptState,
  now = Date.now(),
}: RecordMediaInputResultOptions): void {
  const current: MediaInputModalityState = getMediaInputState(capability);
  const transition: MediaInputTransition = reduceMediaInputResult(current, {
    capability,
    result,
    attemptState,
    now,
  });
  for (const effect of transition.effects) applyMediaInputEffect(effect);
  if (transition.next !== current) replaceModalityState(capability, transition.next);
}
