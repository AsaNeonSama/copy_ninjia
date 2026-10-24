import {
  MEDIA_PROBE_BACKOFF_BASE_MS,
  MEDIA_PROBE_BACKOFF_MAX_MS,
  MEDIA_PROBE_MAX_TRANSIENT_FAILURES,
  NO_MEDIA_INPUT_EFFECTS,
} from "../consts/aiChat/media";
import { isPendingWithin } from "../libs/clockWindow";
import { cappedExponentialMs } from "../libs/backoff";
import type {
  MediaInputSupport,
} from "../types/aiChat/provider";
import type {
  MediaInputResultEvent,
  MediaInputTransition,
  MediaInputModalityState,
} from "../types/states/mediaInputSupport";

/**
 * media 模型视觉/语音输入支持度的状态机（纯函数，不读时钟、不写缓存、
 * 不记日志）。状态含义与整体设计见 types/aiChat/provider.ts 的
 * MediaInputSupport；holder、探测登记与效果执行在
 * cache/workers/aiChat/mediaInputSupport.ts。
 */

/**
 * 不支持与配置错误都阻止新请求；同配置代次的在途成功仍可恢复支持结论。
 * @param support 当前模态的输入支持状态。
 * @returns 状态为 unsupported 或 misconfigured 时返回 true，否则返回 false。
 */
export function isMediaInputClosed(support: MediaInputSupport): boolean {
  return support === "unsupported" || support === "misconfigured";
}

/**
 * 第 n 次连续瞬时失败对应的退避时长；指数增长并封顶。
 * @param transientFailures 连续瞬时失败次数（从 1 起算）。
 * @returns 本次失败应等待的退避毫秒数。
 */
function backoffMsFor(transientFailures: number): number {
  return cappedExponentialMs(MEDIA_PROBE_BACKOFF_BASE_MS, transientFailures - 1, MEDIA_PROBE_BACKOFF_MAX_MS);
}

/**
 * 判断 nextProbeAt 在 now 时刻是否仍处于退避窗口内。
 * nextProbeAt 比 now 远于 MEDIA_PROBE_BACKOFF_MAX_MS 时按墙钟回拨放行（见 libs/clockWindow.ts 的 isPendingWithin）。
 * @param nextProbeAt 下一次允许探测的时间戳（毫秒）。
 * @param now 当前判定时刻的时间戳（毫秒）。
 * @returns 仍处于退避窗口内时返回 true，否则返回 false。
 */
export function isWithinMediaProbeBackoff(nextProbeAt: number, now: number): boolean {
  return isPendingWithin(nextProbeAt, now, MEDIA_PROBE_BACKOFF_MAX_MS);
}

/**
 * 状态不变的归因结果；`next` 原样返回 current，调用方据此跳过整表替换。
 * @param current 当前模态支持状态。
 * @returns 状态保持 current 且无副作用的转移结果。
 */
function unchanged(current: MediaInputModalityState): MediaInputTransition {
  return { next: current, effects: NO_MEDIA_INPUT_EFFECTS };
}

/**
 * 归因一次真实调用的结果。旧配置代次的任何结论与旧状态代次的瞬时失败都不改写
 * 当前状态；单份媒体自身错误（不带 mediaFailure）不改变模态状态。
 * @param current 当前模态支持状态。
 * @param params 本次媒体输入调用的归因事件载荷。
 * @returns 归因后的下一模态状态及可选的告警副作用。
 */
export function reduceMediaInputResult(
  current: MediaInputModalityState,
  { capability, result, attemptState, now }: MediaInputResultEvent
): MediaInputTransition {
  if (attemptState.configGeneration !== current.configGeneration) return unchanged(current);
  if (result.ok) {
    if (current.support === "supported" && current.transientFailures === 0) return unchanged(current);
    return {
      next: {
        support: "supported",
        transientFailures: 0,
        nextProbeAt: 0,
        configGeneration: current.configGeneration,
      },
      effects: NO_MEDIA_INPUT_EFFECTS,
    };
  }

  switch (result.mediaFailure) {
    case "unsupported":
    case "misconfigured": {
      if (current.support === result.mediaFailure) return unchanged(current);
      return {
        next: {
          support: result.mediaFailure,
          transientFailures: 0,
          nextProbeAt: 0,
          configGeneration: current.configGeneration,
        },
        effects: result.mediaFailure === "misconfigured"
          ? [{ kind: "logMisconfiguredMediaEndpoint", capability }]
          : NO_MEDIA_INPUT_EFFECTS,
      };
    }
    case "transient": {
      if (isMediaInputClosed(current.support)) return unchanged(current);
      // 仅首次失败替换状态，同代次其它请求的迟到失败不重复推进退避。
      if (attemptState !== current) return unchanged(current);
      if (isWithinMediaProbeBackoff(current.nextProbeAt, now)) return unchanged(current);
      const transientFailures: number = Math.min(
        current.transientFailures + 1,
        MEDIA_PROBE_MAX_TRANSIENT_FAILURES
      );
      return {
        next: {
          support: current.support,
          transientFailures,
          nextProbeAt: now + backoffMsFor(transientFailures),
          configGeneration: current.configGeneration,
        },
        effects: NO_MEDIA_INPUT_EFFECTS,
      };
    }
    default:
      return unchanged(current);
  }
}
