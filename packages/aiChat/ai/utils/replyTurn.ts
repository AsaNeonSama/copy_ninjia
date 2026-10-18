/**
 * 回复轮次失败结果的公共构造。
 */

import { EMPTY_FUNCTION_CALLS } from "../../../consts/aiChat/tools";
import type { AiReplyTurn } from "../../../types/aiChat/provider";

/**
 * 构造一轮失败的 AiReplyTurn，与成功分支按固定顺序初始化同一组字段。
 */
export function failedReplyTurn(
  webSearchCalls: number,
  finishReason: string | undefined,
  finishDetails: string | undefined
): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: EMPTY_FUNCTION_CALLS,
    webSearchCalls,
    finishReason,
    finishDetails,
    toolCallLimitHit: false,
  };
}
