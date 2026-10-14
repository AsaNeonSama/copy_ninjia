/**
 * 动作执行的停顿节奏：切换聊天状态挡位并按剩余静默期与拟人延时等待；
 * 直接轮协调模型请求期间与串行动作链的状态切换。
 */

import { REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { pauseForToolAction } from "../../utils/toolPause";
import { toolError } from "../../utils/toolResult";
import type { ChatActionControl, ChatActionPhase } from "../../../../types/aiChat/chatAction";
import type { DirectReplyPacing, ReplyActionPause } from "../../../../types/aiChat/replies";

/** 切到目标挡位并执行含剩余静默期的可中止停顿。 */
export function createSimulatedPause(chatAction: ChatActionControl, signal?: AbortSignal): ReplyActionPause {
  return (phase: ChatActionPhase, delayMs: number): Promise<string | null> => {
    const rest: number = chatAction.set(phase);
    return pauseForToolAction({ delayMs: rest + delayMs, signal });
  };
}

/**
 * 直接轮节奏控制：串行链空闲时点亮模型请求挡位，链忙碌时交由链步骤控制并在排空后恢复；
 * 「正在输入」请求交回的首个文字动作直接沿用当前挡位发送，其余动作按拟人停顿等待。
 */
export function createDirectPacing(chatAction: ChatActionControl, signal?: AbortSignal): DirectReplyPacing {
  const simulated: ReplyActionPause = createSimulatedPause(chatAction, signal);
  let requestPhase: ChatActionPhase = "idle";
  let lit: boolean = false;
  let chainBusy: boolean = false;
  return {
    beforeModelRequest: (phase: ChatActionPhase): void => {
      requestPhase = phase;
      if (chainBusy) return;
      if (phase !== "idle") {
        chatAction.set(phase);
        lit = true;
      } else if (lit) {
        chatAction.set("idle");
        lit = false;
      }
    },
    startAction: (text: boolean): ReplyActionPause => {
      let continuing: boolean = text && requestPhase === "typing" && lit;
      requestPhase = "idle";
      return (phase: ChatActionPhase, delayMs: number): Promise<string | null> => {
        if (!continuing) return simulated(phase, delayMs);
        continuing = false;
        chatAction.set(phase);
        return Promise.resolve(null);
      };
    },
    chainStarted: (): void => {
      chainBusy = true;
      lit = false;
    },
    chainDrained: (): void => {
      chainBusy = false;
      if (requestPhase === "idle") return;
      chatAction.set(requestPhase);
      lit = true;
    },
    endModel: (): void => {
      requestPhase = "idle";
      if (!lit) return;
      lit = false;
      chatAction.set("idle");
    },
  };
}

/** pauseThenSettle 的入参。 */
export interface PauseThenSettleOptions {
  readonly isActive: () => boolean;
  readonly chatAction: ChatActionControl;
  readonly pause: ReplyActionPause;
  readonly phase: ChatActionPhase;
  readonly delayMs: number;
}

/** 按 phase 停顿后切回 idle 并等待状态请求落定，复核本轮有效时返回 null，否则返回作废错误回执。 */
export async function pauseThenSettle({
  isActive,
  chatAction,
  pause,
  phase,
  delayMs,
}: PauseThenSettleOptions): Promise<string | null> {
  const invalidated: string | null = await pause(phase, delayMs);
  if (invalidated !== null) return invalidated;
  chatAction.set("idle");
  await chatAction.settle();
  return isActive() ? null : toolError(REPLY_INVALIDATED_TOOL_ERROR);
}
