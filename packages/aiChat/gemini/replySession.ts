import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
/**
 * Gemini 多轮工具回复会话：管理本地 `contents` 历史、显式/隐式上下文缓存切换与服务端 Google Search。
 */

import type {
  Content,
  FunctionCall,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
  Tool,
  ToolConfig,
} from "@google/genai";
import type {
  GeminiContextCacheContent,
  GeminiReplyCacheContentSlot,
} from "../../types/geminiContextCache";
import {
  GEMINI_GROUNDED_REPLY_TEMPERATURE,
  GEMINI_REPLY_ERROR_LABEL,
  GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS,
  GEMINI_REPLY_MAX_TOKENS,
  GEMINI_REPLY_TEMPERATURE,
  GEMINI_SERVER_TOOL_CONFIG,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import {
  geminiReplyLastRequestAt,
  textGeminiContextCache,
  textGeminiReplyCacheContent,
} from "../../cache/workers/aiChat/geminiContextCache";
import { isPlainRecord } from "../../libs/record";
import { getGeminiClient, requestGeminiResult } from "./client";
import {
  acquireGeminiContextCache,
  geminiContextCacheContent,
  releaseGeminiContextCache,
} from "../../infra/geminiContextCache";
import { TEXT_GEMINI_CONTEXT_CACHE_SCOPE } from "./contextCache";
import { countGoogleSearchCalls, responseText } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolOutput,
} from "../../types/aiChat/provider";
import type { AgentCapabilityConfig } from "../../types/config";

/** 构造本轮请求挂载的工具集合（`googleSearch` 与自定义函数声明）。 */
function buildTools(request: AiReplyTurnRequest): Tool[] {
  const tools: Tool[] = [];
  if (request.webSearchEnabled) tools.push({ googleSearch: {} });
  if (request.functions.length > 0) {
    tools.push({ functionDeclarations: [...request.functions] });
  }
  return tools;
}

/** 提取响应中的函数调用列表；无调用时返回 `EMPTY_FUNCTION_CALLS`。 */
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

/** 判断该群上一次成功请求是否仍在 `GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS` 隐式缓存窗口内。 */
function implicitCacheStillWarm(chatId: number, now: number): boolean {
  const lastRequestAt: number | undefined = geminiReplyLastRequestAt.get(chatId);
  return lastRequestAt !== undefined && now - lastRequestAt <= GEMINI_REPLY_EXPLICIT_CACHE_IDLE_MS;
}

/** 记录该群最近一次成功请求的发出时刻（单调递增，不回退）。 */
function noteGeminiReplyRequest(chatId: number, sentAt: number): void {
  const recordedAt: number | undefined = geminiReplyLastRequestAt.get(chatId);
  if (recordedAt !== undefined && sentAt <= recordedAt) return;
  geminiReplyLastRequestAt.set(chatId, sentAt);
}

/** 创建一轮 Gemini 回复会话，固定当前 `text` 能力的配置与客户端。 */
export function createGeminiReplySession(
  { chatId, stableBlocks, volatileBlocks, signal }: AiReplySessionParams
): AiReplySession {
  const textConfig: AgentCapabilityConfig = getAgentDeploymentConfig().text;
  const client: GoogleGenAI = getGeminiClient("text");
  const contents: Content[] = [
    { role: "user", parts: stableBlocks.map((text: string): Part => ({ text })) },
    { role: "user", parts: volatileBlocks.map((text: string): Part => ({ text })) },
  ];
  let pendingModelContent: Content | undefined;
  let firstRequest: boolean = true;

  /** 构造请求体：`cachedContent` 非空时使用显式缓存结构，否则发送完整系统指令与工具声明。 */
  function buildBody(
    request: AiReplyTurnRequest,
    tools: Tool[],
    cachedContent: string | null
  ): GenerateContentParameters {
    const temperature: number = request.grounded ? GEMINI_GROUNDED_REPLY_TEMPERATURE : GEMINI_REPLY_TEMPERATURE;
    const model: string = textConfig.model;
    if (cachedContent !== null) {
      return {
        model,
        contents,
        config: { abortSignal: signal, cachedContent, temperature, maxOutputTokens: GEMINI_REPLY_MAX_TOKENS },
      };
    }
    return {
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
    };
  }

  /** 发送一次 `generateContent` 请求，并在成功时记录发出时刻 `sentAt`。 */
  async function send(
    buildRequestBody: () => GenerateContentParameters,
    sentAt: number
  ): Promise<GeminiRequestResult> {
    const result: GeminiRequestResult = await requestGeminiResult({
      capability: "text",
      buildBody: buildRequestBody,
      errorLabel: GEMINI_REPLY_ERROR_LABEL,
      client,
    });
    if (result.ok) noteGeminiReplyRequest(chatId, sentAt);
    return result;
  }

  /** 获取或计算当前请求对应的显式缓存内容描述与指纹。 */
  function replyCacheContent(model: string, request: AiReplyTurnRequest, tools: Tool[]): GeminiContextCacheContent {
    const toolsJson: string = JSON.stringify(tools);
    const toolConfig: Readonly<ToolConfig> | undefined = request.webSearchEnabled ? GEMINI_SERVER_TOOL_CONFIG : undefined;
    const cached: GeminiReplyCacheContentSlot | null = textGeminiReplyCacheContent.current;
    if (
      cached !== null &&
      cached.content.model === model &&
      cached.content.systemInstruction === request.systemPrompt &&
      cached.content.toolConfig === toolConfig &&
      cached.toolsJson === toolsJson
    ) {
      return cached.content;
    }
    const content: GeminiContextCacheContent = geminiContextCacheContent({
      model,
      systemInstruction: request.systemPrompt,
      tools,
      toolConfig,
    });
    textGeminiReplyCacheContent.current = { content, toolsJson };
    return content;
  }

  /** 按完整结构发送一次请求。 */
  function requestFull(request: AiReplyTurnRequest, tools: Tool[], sentAt: number): Promise<GeminiRequestResult> {
    return send((): GenerateContentParameters => buildBody(request, tools, null), sentAt);
  }

  /**
   * 发送首轮请求：模型支持显式缓存时优先尝试引用共用显式缓存；若缓存因客户端请求错误被拒则释放该缓存并改发完整请求。
   */
  async function requestFirst(request: AiReplyTurnRequest, tools: Tool[], sentAt: number): Promise<GeminiRequestResult> {
    if (getAgentDeploymentConfig().text !== textConfig) return requestFull(request, tools, sentAt);
    const acquired: { name: string | null } = { name: null };
    const result: GeminiRequestResult = await send((): GenerateContentParameters => {
      acquired.name = acquireGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, replyCacheContent(
        textConfig.model,
        request,
        tools
      ));
      return buildBody(request, tools, acquired.name);
    }, sentAt);
    const cachedContent: string | null = acquired.name;
    if (
      cachedContent === null ||
      result.ok ||
      (result.failureKind !== "misconfigured" && result.failureKind !== "rejected")
    ) {
      return result;
    }
    releaseGeminiContextCache(TEXT_GEMINI_CONTEXT_CACHE_SCOPE, cachedContent);
    return requestFull(request, tools, performance.now());
  }

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingModelContent = undefined;
      const tools: Tool[] = buildTools(request);
      const now: number = performance.now();
      const useExplicitCache: boolean =
        firstRequest &&
        textGeminiContextCache.current?.scan !== "unsupported" &&
        !implicitCacheStillWarm(chatId, now);
      firstRequest = false;
      const result: GeminiRequestResult = useExplicitCache
        ? await requestFirst(request, tools, now)
        : await requestFull(request, tools, now);

      const response: GenerateContentResponse | undefined = result.response;
      const webSearchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);

      if (!result.ok) {
        return {
          ok: false,
          text: null,
          functionCalls: EMPTY_FUNCTION_CALLS,
          webSearchCalls,
          finishReason: result.finishReason,
          finishDetails: result.finishDetails,
          toolCallLimitHit: result.finishReason === "TOO_MANY_TOOL_CALLS",
        };
      }
      pendingModelContent = result.response.candidates?.[0]?.content;
      return {
        ok: true,
        text: responseText(result.response) || null,
        functionCalls: extractFunctionCalls(result.response),
        webSearchCalls,
        finishReason: undefined,
        finishDetails: undefined,
        toolCallLimitHit: false,
      };
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
