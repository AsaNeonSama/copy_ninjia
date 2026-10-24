/**
 * Anthropic 多轮工具回复会话：管理本地 `messages` 历史、缓存断点标记、服务端联网检索及 `pause_turn` 续写。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS,
  ANTHROPIC_REPLY_ERROR_LABEL,
  ANTHROPIC_REPLY_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from "../../consts/aiChat/anthropic";
import { failedReplyTurn, succeededReplyTurn } from "../ai/utils/replyTurn";
import { getAgentDeploymentConfig } from "../../config/agent";
import { getAnthropicClient, requestAnthropicMessage } from "./client";
import { countAnthropicWebSearches, messageText, toolUseCalls } from "./response";
import type { AnthropicClient, AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplySessionParams,
  AiReplyTurn,
  AiReplyTurnRequest,
  AiToolDefinition,
  AiToolOutput,
} from "../../types/aiChat/provider";

/**
 * 将中立工具声明转换为 Anthropic Messages 自定义工具定义。
 * @param definition 厂商中立的函数工具声明。
 * @returns Anthropic Beta Messages 自定义工具定义。
 */
function toCustomTool(definition: AiToolDefinition): Anthropic.Beta.BetaTool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.parametersJsonSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

/**
 * 构造本轮请求挂载的工具列表（内建联网检索与自定义工具）。
 * @param request 单轮回复请求参数。
 * @returns 传给 Anthropic Messages 接口的工具联合数组。
 */
function buildTools(request: AiReplyTurnRequest): Anthropic.Beta.BetaToolUnion[] {
  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (request.webSearchEnabled) {
    tools.push({ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] });
  }
  for (const definition of request.functions) tools.push(toCustomTool(definition));
  return tools;
}

/**
 * 按已定切点将当前会话切分为多个文本块追加到 `content`，并在最后一个已定段附加缓存断点。
 * @param content 待追加文本块的目标内容数组。
 * @param text 当前会话消息块文本。
 * @param settledOffsets 会话文本中已定边界的字符偏移升序列表。
 */
function pushConversationSegments(
  content: Anthropic.Beta.BetaTextBlockParam[],
  text: string,
  settledOffsets: readonly number[]
): void {
  let start: number = 0;
  for (let index: number = 0; index < settledOffsets.length; index++) {
    const end: number = settledOffsets[index]!;
    const segment: string = text.slice(start, end);
    content.push(index === settledOffsets.length - 1
      ? { type: "text", text: segment, cache_control: { type: "ephemeral" } }
      : { type: "text", text: segment });
    start = end;
  }
  content.push({ type: "text", text: text.slice(start) });
}

/**
 * 创建一轮 Anthropic 回复会话，固定当前 `text` 能力的模型、客户端与回退状态。
 * @param params 回复会话初始化参数，包含稳定前缀块、易变上下文块、已定会话切点与取消信号。
 * @returns 绑定当前会话历史与工具续写状态的回复会话句柄。
 */
export function createAnthropicReplySession(
  { stableBlocks, volatileBlocks, conversationSettledOffsets = [], signal }: AiReplySessionParams
): AiReplySession {
  const model: string = getAgentDeploymentConfig().text.model;
  const client: AnthropicClient = getAnthropicClient("text");
  const fallbackState: BetaFallbackState = new BetaFallbackState();
  const content: Anthropic.Beta.BetaTextBlockParam[] = [];
  for (let index: number = 0; index < stableBlocks.length; index++) {
    const text: string = stableBlocks[index]!;
    content.push(index === stableBlocks.length - 1
      ? { type: "text", text, cache_control: { type: "ephemeral" } }
      : { type: "text", text });
  }
  for (let index: number = 0; index < volatileBlocks.length; index++) {
    const text: string = volatileBlocks[index]!;
    if (index === 0) pushConversationSegments(content, text, conversationSettledOffsets);
    else content.push({ type: "text", text });
  }
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];
  let pendingAssistant: Anthropic.Beta.BetaContentBlockParam[] | undefined;

  return {
    async request(request: AiReplyTurnRequest): Promise<AiReplyTurn> {
      pendingAssistant = undefined;
      const tools: Anthropic.Beta.BetaToolUnion[] = buildTools(request);
      const system: Anthropic.Beta.BetaTextBlockParam[] = [
        { type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } },
      ];
      let paused: Anthropic.Beta.BetaContentBlockParam[] | null = null;
      let webSearchCalls: number = 0;
      let text: string = "";
      for (let continuation: number = 0; ; continuation++) {
        const prefix: Anthropic.Beta.BetaContentBlockParam[] | null = paused;
        const result: AnthropicRequestResult = await requestAnthropicMessage({
          capability: "text",
          buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
            model,
            system,
            messages: prefix === null ? messages : [...messages, { role: "assistant", content: prefix }],
            tools,
            max_tokens: ANTHROPIC_REPLY_MAX_TOKENS,
            cache_control: { type: "ephemeral" },
          }),
          errorLabel: ANTHROPIC_REPLY_ERROR_LABEL,
          signal,
          client,
          fallbackState,
        });
        const searches: number = result.message === undefined ? 0 : countAnthropicWebSearches(result.message);
        webSearchCalls += searches;

        if (!result.ok) {
          return failedReplyTurn({
            webSearchCalls,
            finishReason: result.stopReason,
            finishDetails: result.stopDetails,
          });
        }
        text += messageText(result.message);
        const blocks: Anthropic.Beta.BetaContentBlockParam[] = prefix === null
          ? result.message.content
          : [...prefix, ...result.message.content];
        const functionCalls: readonly AiFunctionCall[] = toolUseCalls(result.message);
        if (result.message.stop_reason === "pause_turn" && functionCalls.length === 0) {
          if (continuation >= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS) {
            return failedReplyTurn({ webSearchCalls, finishReason: "pause_turn" });
          }
          paused = blocks;
          continue;
        }
        pendingAssistant = blocks;
        return succeededReplyTurn(text || null, functionCalls, webSearchCalls);
      }
    },

    appendToolOutputs(outputs: readonly AiToolOutput[]): boolean {
      if (pendingAssistant === undefined) return false;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const output of outputs) {
        results.push({ type: "tool_result", tool_use_id: output.call.id ?? "", content: output.responseJson });
      }
      messages.push({ role: "assistant", content: pendingAssistant }, { role: "user", content: results });
      pendingAssistant = undefined;
      return true;
    },
  };
}
