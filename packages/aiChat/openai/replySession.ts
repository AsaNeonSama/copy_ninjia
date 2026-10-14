/**
 * OpenAI 多轮工具回复会话：管理本地 `input` 历史、提示词缓存键与断点，以及服务端 hosted `web_search`。
 */

import type OpenAI from "openai";
import {
  OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX,
  OPENAI_PROMPT_CACHE_KEY_PREFIX,
  OPENAI_PROMPT_CACHE_TTL,
  OPENAI_REPLY_ERROR_LABEL,
  OPENAI_REPLY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { getOpenAiClient, requestOpenAiResult } from "./client";
import { stablePrefixFingerprintWithSlot } from "../../libs/prefixFingerprint";
import { openAiReplyPrefixSlot } from "../../cache/workers/aiChat/replyPrefix";
import {
  countWebSearchCalls,
  extractFunctionCalls,
  isPairableFunctionCall,
  responseOutputItems,
  responseOutputText,
} from "./response";
import { failedReplyTurn } from "../ai/utils/replyTurn";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type {
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";
import type { AgentCapabilityConfig } from "../../types/config";

/** 将中立工具声明转换为 OpenAI Responses 的函数工具定义。 */
function toFunctionTool(definition: AiToolDefinition): OpenAI.Responses.Tool {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.parametersJsonSchema,
    strict: false,
  };
}

/** 构造本轮请求挂载的工具集合。 */
function buildTools(request: AiReplyTurnRequest): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = [];
  if (request.webSearchEnabled) tools.push({ type: "web_search" });
  for (const definition of request.functions) tools.push(toFunctionTool(definition));
  return tools;
}

/** 判断当前配置是否支持显式 `prompt_cache_breakpoint` 与 `prompt_cache_options`。 */
function supportsPromptCacheBreakpoints(config: AgentCapabilityConfig): boolean {
  if (config.provider !== "openai" || config.baseUrl !== undefined) return false;
  return config.model === OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX ||
    config.model.startsWith(OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX + "-");
}

/** 筛选模型输出项中可回填至后续轮次 `input` 的加密推理、函数调用、消息与检索记录。 */
function toInputItems(output: readonly OpenAI.Responses.ResponseOutputItem[]): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const item of output) {
    if (
      item.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content.length > 0
    ) {
      items.push(item);
    } else if (item.type === "function_call") {
      if (isPairableFunctionCall(item)) items.push(item);
    } else if (item.type === "message" || item.type === "web_search_call") {
      items.push(item);
    }
  }
  return items;
}

/** 创建一轮 OpenAI 回复会话，固定当前 `text` 能力的配置与客户端。 */
export function createOpenAiReplySession(
  { stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const config: AgentCapabilityConfig = getAgentDeploymentConfig().text;
  const client: OpenAI = getOpenAiClient("text");
  const useBreakpoints: boolean = stableBlocks.length > 0 && supportsPromptCacheBreakpoints(config);
  const content: OpenAI.Responses.ResponseInputContent[] = [];
  for (let index: number = 0; index < stableBlocks.length; index += 1) {
    const text: string | undefined = stableBlocks[index];
    if (text === undefined) continue;
    if (index === stableBlocks.length - 1) {
      content.push({
        type: "input_text",
        text,
        prompt_cache_breakpoint: useBreakpoints ? { mode: "explicit" } : undefined,
      });
    } else {
      content.push({ type: "input_text", text });
    }
  }
  for (const text of volatileBlocks) content.push({ type: "input_text", text });
  const input: OpenAI.Responses.ResponseInputItem[] = [{ role: "user", content }];
  let pendingModelItems: OpenAI.Responses.ResponseInputItem[] | undefined;

  let cacheKey: string | undefined;
  let keyedFunctions: readonly AiToolDefinition[] | undefined;
  let keyedWebSearchEnabled: boolean | undefined;
  let keyedSystemPrompt: string | undefined;

  /** 计算或复用当前请求的 `prompt_cache_key`。 */
  function promptCacheKeyFor(request: AiReplyTurnRequest, tools: readonly OpenAI.Responses.Tool[]): string {
    if (
      cacheKey !== undefined &&
      keyedFunctions === request.functions &&
      keyedWebSearchEnabled === request.webSearchEnabled &&
      keyedSystemPrompt === request.systemPrompt
    ) {
      return cacheKey;
    }
    const fingerprint: string = stablePrefixFingerprintWithSlot(
      openAiReplyPrefixSlot,
      [request.systemPrompt, JSON.stringify(tools)],
      stableBlocks
    );
    cacheKey = OPENAI_PROMPT_CACHE_KEY_PREFIX + ":" + fingerprint;
    keyedFunctions = request.functions;
    keyedWebSearchEnabled = request.webSearchEnabled;
    keyedSystemPrompt = request.systemPrompt;
    return cacheKey;
  }

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelItems = undefined;
      const tools: OpenAI.Responses.Tool[] = buildTools(request);
      const promptCacheKey: string = promptCacheKeyFor(request, tools);
      const result: OpenAiRequestResult = await requestOpenAiResult({
        capability: "text",
        buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
          model: config.model,
          instructions: request.systemPrompt,
          input,
          tools,
          prompt_cache_key: promptCacheKey,
          prompt_cache_options: useBreakpoints
            ? { mode: "implicit", ttl: OPENAI_PROMPT_CACHE_TTL }
            : undefined,
          max_output_tokens: OPENAI_REPLY_MAX_TOKENS,
          store: OPENAI_STORE_RESPONSES,
        }),
        errorLabel: OPENAI_REPLY_ERROR_LABEL,
        signal,
        client,
      });

      const response: OpenAI.Responses.Response | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countWebSearchCalls(response);

      if (!result.ok) return failedReplyTurn(webSearchCalls, result.finishReason, result.finishDetails);
      pendingModelItems = toInputItems(responseOutputItems(result.response));
      return {
        ok: true,
        text: responseOutputText(result.response) || null,
        functionCalls: extractFunctionCalls(result.response),
        webSearchCalls,
        finishReason: undefined,
        finishDetails: undefined,
        toolCallLimitHit: false,
      };
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      if (!pendingModelItems) return false;
      const results: OpenAI.Responses.ResponseInputItem[] = [];
      for (const output of outputs) {
        if (output.call.id === undefined) return false;
        results.push({
          type: "function_call_output",
          call_id: output.call.id,
          output: output.responseJson,
        });
      }
      input.push(...pendingModelItems, ...results);
      pendingModelItems = undefined;
      return true;
    },
  };
}
