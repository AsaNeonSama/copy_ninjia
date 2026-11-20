/**
 * Gemini 多轮工具回复会话：管理本地 `contents` 历史与服务端 Google Search，前缀稳定区块由服务端隐式缓存自动命中。
 */

import { EMPTY_FUNCTION_CALLS } from "../../../consts/aiChat/tools";

import type {
  Content,
  FunctionCall,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
  Tool,
} from "@google/genai";
import {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_ERROR_LABEL,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
  GEMINI_SERVER_TOOL_CONFIG,
} from "../../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../../config/agent";
import { isPlainRecord } from "../../../libs/record";
import { getGeminiClient, requestGeminiResult } from "./client";
import { countGoogleSearchCalls, responseText } from "../../../aiProviders/gemini/response";
import { failedReplyTurn, succeededReplyTurn } from "../ai/utils/replyTurn";
import type { GeminiRequestResult } from "../../../types/aiChat/gemini";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolOutput,
} from "../../../types/aiChat/provider";

/**
 * 构造本轮请求挂载的工具集合（`googleSearch` 与自定义函数声明）。
 * @param request 单轮回复请求参数。
 * @returns 传给 Gemini `generateContent` 的工具声明列表。
 */
function buildTools(request: AiReplyTurnRequest): Tool[] {
  const tools: Tool[] = [];
  if (request.webSearchEnabled) tools.push({ googleSearch: {} });
  if (request.functions.length > 0) {
    tools.push({ functionDeclarations: [...request.functions] });
  }
  return tools;
}

/**
 * 提取响应中的函数调用列表；无调用时返回 `EMPTY_FUNCTION_CALLS`。
 * @param data Gemini `generateContent` 响应对象。
 * @returns 转换后的中立函数调用只读数组。
 */
function extractFunctionCalls(data: GenerateContentResponse): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const call of data.functionCalls ?? []) {
    if (typeof call.name !== "string") continue;
    const typed: FunctionCall = call;
    calls.push({
      id: typed.id,
      name: call.name,
      argumentsJson: JSON.stringify(typed.args ?? {}),
    });
  }
  return calls.length === 0 ? EMPTY_FUNCTION_CALLS : calls;
}

/**
 * 创建一轮 Gemini 回复会话，固定当前 `text` 能力的模型名与客户端。
 * @param params 回复会话初始化参数，包含稳定前缀块、易变上下文块与取消信号。
 * @returns 绑定当前会话历史与固定配置的回复会话句柄。
 */
export function createGeminiReplySession(
  { stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const model: string = getAgentDeploymentConfig().text.model;
  const client: GoogleGenAI = getGeminiClient("text");
  const contents: Content[] = [
    { role: "user", parts: stableBlocks.map((text: string): Part => ({ text })) },
    { role: "user", parts: volatileBlocks.map((text: string): Part => ({ text })) },
  ];
  let pendingModelContent: Content | undefined;

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelContent = undefined;
      const tools: Tool[] = buildTools(request);
      const temperature: number = request.grounded ? GEMINI_GROUNDED_REPLY_TEMPERATURE : GEMINI_REPLY_TEMPERATURE;
      const result: GeminiRequestResult = await requestGeminiResult({
        capability: "text",
        buildBody: (): GenerateContentParameters => ({
          model,
          contents,
          config: {
            abortSignal: signal,
            temperature,
            maxOutputTokens: GEMINI_REPLY_MAX_TOKENS,
            systemInstruction: request.systemPrompt,
            tools,
            toolConfig: request.webSearchEnabled ? GEMINI_SERVER_TOOL_CONFIG : undefined,
          },
        }),
        errorLabel: GEMINI_REPLY_ERROR_LABEL,
        client,
      });

      const response: GenerateContentResponse | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);

      if (!result.ok) {
        return failedReplyTurn({
          webSearchCalls,
          finishReason: result.finishReason,
          finishDetails: result.finishDetails,
          toolCallLimitHit: result.finishReason === "TOO_MANY_TOOL_CALLS",
        });
      }
      pendingModelContent = result.response.candidates?.[0]?.content;
      return succeededReplyTurn(
        responseText(result.response) || null,
        extractFunctionCalls(result.response),
        webSearchCalls
      );
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      if (!pendingModelContent) return false;
      contents.push(pendingModelContent);
      pendingModelContent = undefined;
      const responseParts: Part[] = [];
      for (const output of outputs) {
        const parsed: unknown = JSON.parse(output.responseJson);
        if (!isPlainRecord(parsed)) throw new Error(`Tool ${output.call.name} returned a non-object JSON value`);
        responseParts.push({ functionResponse: { id: output.call.id, name: output.call.name, response: parsed } });
      }
      contents.push({ role: "user", parts: responseParts });
      return true;
    },
  };
}
