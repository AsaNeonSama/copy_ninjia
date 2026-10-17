/**
 * OpenAI Responses 响应解析辅助：提取 `output` 列表、正文、拒答说明、异常收尾诊断与详情、函数调用及联网检索次数。
 */

import { EMPTY_OUTPUT_ITEMS } from "../../consts/aiChat/openai";
import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";

import { finishDetailsJson } from "../ai/utils/finishDetails";
import type OpenAI from "openai";
import type { AiFunctionCall } from "../../types/aiChat/provider";

/** 读取响应的 `output` 数组；缺失或非数组时返回 `EMPTY_OUTPUT_ITEMS`。 */
export function responseOutputItems(response: OpenAI.Responses.Response): readonly OpenAI.Responses.ResponseOutputItem[] {
  const output: readonly OpenAI.Responses.ResponseOutputItem[] | undefined = response.output;
  return Array.isArray(output) ? output : EMPTY_OUTPUT_ITEMS;
}

/** 拼接响应消息项中全部 `refusal` 内容块的文本；无 `refusal` 块时返回 undefined。 */
export function responseRefusal(response: OpenAI.Responses.Response): string | undefined {
  let refusal: string | undefined;
  for (const item of responseOutputItems(response)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type !== "refusal") continue;
      refusal = (refusal ?? "") + (typeof part.refusal === "string" ? part.refusal : "");
    }
  }
  return refusal;
}

/** 检查响应是否异常（含 `error`、非 `completed` 状态、拒答或空 `output`）；异常时返回诊断字符串，正常时返回 null。 */
export function abnormalResponseDiagnostic(response: OpenAI.Responses.Response): string | null {
  if (response.error) return "error";
  if (response.status !== undefined && response.status !== "completed") {
    const reason: string | undefined = response.incomplete_details?.reason;
    return `status=${response.status}` + (reason === undefined ? "" : `, reason=${reason}`);
  }
  if (responseRefusal(response) !== undefined) return "refusal";
  if (responseOutputItems(response).length === 0) return "no output items";
  return null;
}

/** 序列化响应的收尾诊断详情（`{ error, refusal }`）；两者均缺省时返回 undefined。 */
export function openAiFinishDetails(response: OpenAI.Responses.Response): string | undefined {
  const error: unknown = response.error ?? undefined;
  const refusal: string | undefined = responseRefusal(response);
  if (error === undefined && refusal === undefined) return undefined;
  return finishDetailsJson({ error, refusal });
}

/** 读取响应的 `output_text` 字符串；非字符串时返回空串。 */
export function responseOutputText(response: OpenAI.Responses.Response): string {
  const text: unknown = response.output_text;
  return typeof text === "string" ? text : "";
}

/** 归一化响应的收尾原因：非 `completed` 时返回状态与原因，含拒答块时返回 `"refusal"`，否则返回 undefined。 */
export function normalizedFinishReason(response: OpenAI.Responses.Response): string | undefined {
  if (response.status === undefined || response.status === "completed") {
    return responseRefusal(response) === undefined ? undefined : "refusal";
  }
  const reason: string | undefined = response.incomplete_details?.reason;
  return reason === undefined ? response.status : `${response.status}:${reason}`;
}

/** 判断响应是否因达到 `max_output_tokens` 而截断。 */
export function isTruncatedByTokenLimit(response: OpenAI.Responses.Response): boolean {
  return response.incomplete_details?.reason === "max_output_tokens";
}

/** 判断输出项是否为带非空 `call_id` 的函数调用。 */
export function isPairableFunctionCall(item: OpenAI.Responses.ResponseOutputItem): boolean {
  return item.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0;
}

/** 提取响应中可配对的函数调用列表；无调用时返回 `EMPTY_FUNCTION_CALLS`。 */
export function extractFunctionCalls(response: OpenAI.Responses.Response): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const item of responseOutputItems(response)) {
    if (item.type !== "function_call" || !isPairableFunctionCall(item)) continue;
    calls.push({
      id: item.call_id,
      name: item.name,
      argumentsJson: item.arguments.length > 0 ? item.arguments : "{}",
    });
  }
  return calls.length === 0 ? EMPTY_FUNCTION_CALLS : calls;
}

/** 统计响应中已完成的 `web_search_call` 检索动作次数。 */
export function countWebSearchCalls(response: OpenAI.Responses.Response): number {
  let calls: number = 0;
  for (const item of responseOutputItems(response)) {
    if (item.type === "web_search_call" && item.action?.type === "search" && item.status === "completed") calls++;
  }
  return calls;
}
