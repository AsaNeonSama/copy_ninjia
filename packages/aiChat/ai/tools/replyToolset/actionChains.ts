import { SEND_MESSAGE_TOOL } from "../../../../consts/tools";
import { logger } from "../../../../infra/logger";
import { trackInflight } from "../../../../libs/inflight";
import { raceAbort } from "../../../../libs/abortSignal";
import { parseToolResult } from "../../utils/toolResult";
import { createSimulatedPause } from "./pacing";
import type { ParsedToolResult } from "../../utils/toolResult";
import type {
  DirectReplyPacing,
  ReplyActionChains,
  ReplyActionPause,
  ReplyActionRun,
  ReplyToolContext,
} from "../../../../types/aiChat/replies";

/**
 * 本轮串行动作链：按工具调用顺序串行执行已接纳动作并切换 ctx.chatAction，每步结束后复位为 idle。
 * 转入后台的动作（defer）在结算得到执行函数后排入链尾；直接轮通过 pacing 协调请求期间与链执行期间的状态。
 * 生命周期约束见 docs/cn/04-invariants.md。
 */
export function createReplyActionChains(
  ctx: ReplyToolContext,
  ready: Promise<void> = Promise.resolve(),
  pacing: DirectReplyPacing | null = null
): ReplyActionChains {
  const inflight: Set<Promise<unknown>> = new Set();
  let tail: Promise<void> = ready;
  let completed: number = 0;
  let queued: number = 0;
  const pause: ReplyActionPause = createSimulatedPause(ctx.chatAction, ctx.signal);

  function record(name: string, result: string): void {
    const parsed: ParsedToolResult = parseToolResult(result);
    completed += parsed.actionsUsed;
    if (parsed.error !== null && ctx.isActive()) {
      logger.error(`AI reply action failed (chat ${ctx.chatId}, tool ${name}): ${parsed.error}`);
    }
  }

  function enqueue(name: string, run: ReplyActionRun, stepPause: ReplyActionPause): void {
    queued++;
    if (queued === 1) pacing?.chainStarted();
    const task: Promise<void> = raceAbort(tail, {
      signal: ctx.signal,
      cancelled: undefined,
      rejected: undefined,
    }).then(async (): Promise<void> => {
      try {
        record(name, await run(ctx.chatAction, stepPause));
      } finally {
        ctx.chatAction.set("idle");
      }
    }).catch((error: unknown): void => {
      if (ctx.isActive()) logger.error(`AI reply action chain failed (chat ${ctx.chatId}, tool ${name}):`, error);
    }).finally((): void => {
      queued--;
      if (queued === 0) pacing?.chainDrained();
    });
    tail = task;
    void trackInflight(inflight, task);
  }

  return {
    start: (name: string, run: ReplyActionRun): void => {
      enqueue(name, run, pacing === null ? pause : pacing.startAction(name === SEND_MESSAGE_TOOL));
    },
    defer: (name: string, pending: Promise<ReplyActionRun | null>): void => {
      void trackInflight(inflight, pending.then(
        (run: ReplyActionRun | null): void => {
          if (run !== null) enqueue(name, run, pause);
        },
        (error: unknown): void => {
          if (ctx.isActive()) logger.error(`AI reply background action failed (chat ${ctx.chatId}, tool ${name}):`, error);
        }
      ));
    },
    settle: async (): Promise<void> => {
      while (inflight.size > 0) await Promise.allSettled(inflight);
    },
    completed: (): number => completed,
  };
}
