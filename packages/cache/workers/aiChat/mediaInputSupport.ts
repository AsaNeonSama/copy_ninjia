/** owner: workers/aiChat。media 能力视觉与语音输入支持度状态及首次探测单飞槽（packages/states/mediaInputSupport.ts）。 */

import type { SharedResult } from "../../../libs/sharedResult";
import { logger } from "../../../infra/logger";
import { INITIAL_MEDIA_INPUT_STATE } from "../../../consts/aiChat/media";
import {
  isWithinMediaProbeBackoff,
  reduceMediaInputResult,
} from "../../../states/mediaInputSupport";
import type {
  AiTextResult,
  MediaInputCapability,
} from "../../../types/aiChat/provider";
import type {
  MediaInputEffect,
  MediaInputTransition,
  MediaInputModalityState,
  MediaInputSupportState,
} from "../../../types/states/mediaInputSupport";

interface MediaInputProbeState {
  vision: SharedResult<AiTextResult> | null;
  voice: SharedResult<AiTextResult> | null;
}

/** 当前 Worker 的视觉与语音模态输入支持度状态单例：首次读取时按 INITIAL_MEDIA_INPUT_STATE 初始化，recordMediaInputResult 归因更新，agent.json 热重载替换 media 能力时由 resetMediaInputSupport 推进配置代次并重置为未探测；固定两个模态字段，不淘汰，Worker 重建后从 null 开始。 */
export const mediaInputSupportCache: { current: MediaInputSupportState | null } = { current: null };

/** 当前 Worker 视觉与语音模态的在途首次探测单飞槽单例：setMediaInputProbe 登记，探测结束由 clearMediaInputProbe 按任务身份清除，resetMediaInputSupport 时置为 null；每种模态至多一个在途探测，Worker 重建后从 null 开始。 */
export const mediaInputProbeCache: { current: MediaInputProbeState | null } = { current: null };

/** 读取指定模态当前正在进行的首次探测任务。 */
export function getMediaInputProbe(capability: MediaInputCapability): SharedResult<AiTextResult> | null {
  const state: MediaInputProbeState = mediaInputProbeCache.current ??= {
    vision: null,
    voice: null,
  };
  return state[capability];
}

/** 同步登记指定模态的首次探测任务。 */
export function setMediaInputProbe(
  capability: MediaInputCapability,
  pending: SharedResult<AiTextResult>
): void {
  const state: MediaInputProbeState = mediaInputProbeCache.current ??= {
    vision: null,
    voice: null,
  };
  state[capability] = pending;
}

/** 按任务引用身份清除已结算的首次探测登记。 */
export function clearMediaInputProbe(
  capability: MediaInputCapability,
  pending: SharedResult<AiTextResult>
): void {
  const state: MediaInputProbeState | null = mediaInputProbeCache.current;
  if (state?.[capability] === pending) state[capability] = null;
}

/** 递增 media 配置代次，将视觉与语音支持度重置为 unknown 并清空在途首次探测登记。 */
export function resetMediaInputSupport(): void {
  const configGeneration: number = supportState().vision.configGeneration + 1;
  mediaInputSupportCache.current = {
    vision: { support: "unknown", transientFailures: 0, nextProbeAt: 0, configGeneration },
    voice: { support: "unknown", transientFailures: 0, nextProbeAt: 0, configGeneration },
  };
  mediaInputProbeCache.current = null;
}

function supportState(): MediaInputSupportState {
  return mediaInputSupportCache.current ??= {
    vision: INITIAL_MEDIA_INPUT_STATE,
    voice: INITIAL_MEDIA_INPUT_STATE,
  };
}

function replaceModalityState(
  capability: MediaInputCapability,
  next: MediaInputModalityState
): void {
  const state: MediaInputSupportState = supportState();
  mediaInputSupportCache.current = capability === "vision"
    ? { vision: next, voice: state.voice }
    : { vision: state.vision, voice: next };
}

/** 读取指定模态的当前输入支持度状态快照。 */
export function getMediaInputState(capability: MediaInputCapability): MediaInputModalityState {
  return supportState()[capability];
}

/** 判断指定模态当前是否处于探测退避冷却期内。 */
export function isMediaInputProbeCoolingDown(
  capability: MediaInputCapability,
  now: number
): boolean {
  return isWithinMediaProbeBackoff(getMediaInputState(capability).nextProbeAt, now);
}

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
  readonly capability: MediaInputCapability;
  readonly result: AiTextResult;
  readonly attemptState: MediaInputModalityState;
  readonly now?: number;
}

/** 根据单次媒体调用结果演进模态支持度状态并执行副作用。 */
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
