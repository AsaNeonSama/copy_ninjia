/**
 * 回复轮次结果的公共构造。
 */

import { EMPTY_FUNCTION_CALLS } from "../../../consts/aiChat/tools";
import type { AiFunctionCall, AiReplyTurn } from "../../../types/aiChat/provider";

/** failedReplyTurn 的入参。 */
export interface FailedReplyTurnParams {
  /** 本轮已发生的联网搜索调用次数。 */
  readonly webSearchCalls: number;
  /** 供应商返回的停止原因标识。 */
  readonly finishReason?: string;
  /** 供应商收尾详情的截断 JSON 字符串。 */
  readonly finishDetails?: string;
  /** 是否触发供应商侧单次生成的工具调用上限。 */
  readonly toolCallLimitHit?: boolean;
}

/**
 * 构造一轮失败的 AiReplyTurn，与成功分支按固定顺序初始化同一组字段。
 * @param params 失败回复轮次构造参数。
 * @returns 标记为失败的回复轮次结果。
 */
export function failedReplyTurn({
  webSearchCalls,
  finishReason,
  finishDetails,
  toolCallLimitHit = false,
}: FailedReplyTurnParams): AiReplyTurn {
  return {
    ok: false,
    text: null,
    functionCalls: EMPTY_FUNCTION_CALLS,
    webSearchCalls,
    finishReason,
    finishDetails,
    toolCallLimitHit,
  };
}

/**
 * 构造一轮成功的 AiReplyTurn，与失败分支按固定顺序初始化同一组字段。
 * @param text 模型输出的正文文本；为空时传 `null`。
 * @param functionCalls 模型发起的函数工具调用列表。
 * @param webSearchCalls 本轮已发生的联网搜索调用次数。
 * @returns 标记为成功的回复轮次结果。
 */
export function succeededReplyTurn(
  text: string | null,
  functionCalls: readonly AiFunctionCall[],
  webSearchCalls: number
): AiReplyTurn {
  return {
    ok: true,
    text,
    functionCalls,
    webSearchCalls,
    finishReason: undefined,
    finishDetails: undefined,
    toolCallLimitHit: false,
  };
}
