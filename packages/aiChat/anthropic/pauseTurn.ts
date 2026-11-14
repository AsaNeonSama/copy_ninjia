/**
 * Anthropic Messages `pause_turn` 续写循环：统一管理 `paused` 内容前缀累积、
 * 服务端联网检索次数累加及 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 上限检查。
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { BetaFallbackState } from "@anthropic-ai/sdk";
import { ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS } from "../../consts/aiChat/anthropic";
import { requestAnthropicMessage } from "./client";
import { countAnthropicWebSearches } from "./response";
import type {
  AnthropicClient,
  AnthropicRequestFailure,
  AnthropicRequestResult,
} from "../../types/aiChat/anthropic";
import type { AgentCapability } from "../../types/config";

/** `handleMessage` 返回该哨兵值时，表示按当前 `blocks` 作为 `paused` 前缀继续下一次 `pause_turn` 续发。 */
export const PAUSE_TURN_CONTINUE: unique symbol = Symbol("pauseTurnContinue");

/** `handleMessage` 收到的单步成功消息上下文。 */
export interface AnthropicPauseTurnStep {
  /** 本次 Anthropic Messages 响应对象。 */
  readonly message: Anthropic.Beta.BetaMessage;
  /** 截至本步已累加的服务端联网检索次数。 */
  readonly webSearchCalls: number;
  /** 从轮次起点累积至本步响应的 assistant 内容块序列。 */
  readonly blocks: Anthropic.Beta.BetaContentBlockParam[];
}

/** Anthropic `pause_turn` 有界续写循环的调用参数。 */
export interface AnthropicPauseTurnOptions<TResult> {
  /** 调用对应的 AI 能力槽位。 */
  readonly capability: AgentCapability;
  /** 错误与告警日志前缀标签。 */
  readonly errorLabel: string;
  /** 外部取消信号。 */
  readonly signal?: AbortSignal;
  /** 会话固定的客户端；缺省时按 capability 获取。 */
  readonly client?: AnthropicClient;
  /** 拒答回退中间件的状态对象；缺省时由每次请求各自管理。 */
  readonly fallbackState?: BetaFallbackState;
  /** 按当前累积的 `paused` 前缀构造非流式 Messages 请求体。 */
  readonly buildBody: (
    prefix: Anthropic.Beta.BetaContentBlockParam[] | null
  ) => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  /** 请求失败或收尾不可用时的结果映射回调。 */
  readonly onFailure: (failure: AnthropicRequestFailure, webSearchCalls: number) => TResult;
  /** 收到可用消息后的判定回调：返回最终结果或 `PAUSE_TURN_CONTINUE` 以继续续发。 */
  readonly handleMessage: (step: AnthropicPauseTurnStep) => TResult | typeof PAUSE_TURN_CONTINUE;
  /** `pause_turn` 续写次数达到 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 上限时的结果映射回调。 */
  readonly onPauseLimitExceeded: (webSearchCalls: number) => TResult;
}

/**
 * 执行一轮带 `pause_turn` 自动续发的 Anthropic Messages 请求序列，累加联网检索调用次数并在
 * 达到 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 后交由 `onPauseLimitExceeded` 收口。
 * @param options 续写循环配置及请求失败、逐消息判定与超限处理回调。
 * @returns 由业务判定回调或失败/超限收口回调产出的结果。
 */
export async function requestAnthropicWithPauseTurn<TResult>({
  capability,
  errorLabel,
  signal,
  client,
  fallbackState,
  buildBody,
  onFailure,
  handleMessage,
  onPauseLimitExceeded,
}: AnthropicPauseTurnOptions<TResult>): Promise<TResult> {
  let webSearchCalls: number = 0;
  let paused: Anthropic.Beta.BetaContentBlockParam[] | null = null;
  for (let continuation: number = 0; ; continuation++) {
    const prefix: Anthropic.Beta.BetaContentBlockParam[] | null = paused;
    const result: AnthropicRequestResult = await requestAnthropicMessage({
      capability,
      buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => buildBody(prefix),
      errorLabel,
      signal,
      client,
      fallbackState,
    });
    const searches: number = result.message === undefined ? 0 : countAnthropicWebSearches(result.message);
    webSearchCalls += searches;

    if (!result.ok) return onFailure(result, webSearchCalls);
    const blocks: Anthropic.Beta.BetaContentBlockParam[] = prefix === null
      ? result.message.content
      : [...prefix, ...result.message.content];
    const outcome: TResult | typeof PAUSE_TURN_CONTINUE = handleMessage({
      message: result.message,
      webSearchCalls,
      blocks,
    });
    if (outcome !== PAUSE_TURN_CONTINUE) return outcome;
    if (continuation >= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS) {
      return onPauseLimitExceeded(webSearchCalls);
    }
    paused = blocks;
  }
}
