import { getPersona } from "../../config/persona";
import {
  MAX_CUSTOM_TOOL_CALLS_PER_REPLY,
  MAX_WEB_SEARCH_CALLS_PER_REPLY,
  MAX_TOOL_ROUNDS,
} from "../../consts/aiChat/tools";
import {
  CHAT_INTERACTION_INSTRUCTION,
  CHAT_MEMORY_PRIORITY_INSTRUCTION,
  DIRECT_INVOCATION_READING_INSTRUCTION,
  MEMORY_MECHANISM_SILENCE_INSTRUCTION,
  REPLY_CONTEXT_STRUCTURE_INSTRUCTION,
  TRANSCRIPT_FORMAT_INSTRUCTION,
} from "../../consts/aiChat/prompts/memory";
import { AI_CHAT_AGENT_ROLE_INSTRUCTION } from "../../consts/aiChat/prompts/agent";
import { WEB_SEARCH_FUNCTION_INSTRUCTION, WEB_SEARCH_INSTRUCTION } from "../../consts/aiChat/prompts/search";
import { logger } from "../../infra/logger";
import { textAiProvider } from "../../aiChat/provider";
import { ABUSE_MARK_TOOL, TOOL_BUDGET_EXHAUSTED_RESULT, WEB_SEARCH_TOOL } from "../../consts/tools";
import { callTool } from "../../aiChat/ai/tools";
import { diagnosticWithDetails } from "../../aiChat/ai/utils/finishDetails";
import { parseToolResult } from "../../aiChat/ai/utils/toolResult";
import type {
  ReplyPromptSections,
  ReplySystemPromptSlot,
  ReplyToolset,
  WebSearchToolOutcome,
} from "../../types/aiChat/replies";
import { replySystemPromptSlot } from "../../cache/workers/aiChat/replyPrefix";
import type {
  AiFunctionCall,
  AiReplySession,
  AiReplyTurn,
  AiToolOutput,
} from "../../types/aiChat/provider";
import { buildRuntimeStateBlock } from "./runtimeState";

/**
 * 单轮 AI 回复的模型往返编排：组装系统提示词与四段上下文区块，驱动多轮工具调用、
 * 预算核算与检索超限降级重试。前缀缓存与预算约束见 docs/cn/04-invariants.md。
 */

/**
 * 将按函数名累计的调用次数格式化为有序诊断字符串。
 *
 * @param counts 工具函数名到调用次数的只读映射
 * @returns 形如 `name:count,...` 的诊断文本；映射为空时返回 `"none"`
 */
function toolCountsDiagnostic(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()].sort(([left]: [string, number], [right]: [string, number]): number => left.localeCompare(right))
    .map(([name, count]: [string, number]): string => `${name}:${count}`).join(",") || "none";
}

/**
 * 组装或复用单槽缓存中的回复系统提示词（状态见 cache/workers/aiChat/replyPrefix.ts）。
 *
 * @param toolset 本轮回复的工具集与提示词能力边界
 * @returns 完整的静态回复系统提示词文本
 */
function buildReplySystemPrompt(toolset: ReplyToolset): string {
  const persona: string = getPersona();
  const actionInstruction: string = toolset.replyActionInstruction;
  const functionSearch: boolean = toolset.searchWeb !== null;
  const slot: ReplySystemPromptSlot | null = replySystemPromptSlot.current;
  if (
    slot !== null &&
    slot.persona === persona &&
    slot.actionInstruction === actionInstruction &&
    slot.functionSearch === functionSearch
  ) {
    return slot.prompt;
  }
  const prompt: string = composeReplySystemPrompt(persona, actionInstruction, functionSearch);
  replySystemPromptSlot.current = { persona, actionInstruction, functionSearch, prompt };
  return prompt;
}

/**
 * 按固定顺序拼接回复系统提示词全文。
 *
 * @param persona 角色设定提示词正文
 * @param actionInstruction 本轮可用行动工具与停止规则说明
 * @param functionSearch 是否通过本地 `web_search` 函数暴露联网检索能力
 * @returns 拼接完成的回复系统提示词全文
 */
function composeReplySystemPrompt(persona: string, actionInstruction: string, functionSearch: boolean): string {
  return `${persona}\n\n## Agent 身份与权限边界\n${AI_CHAT_AGENT_ROLE_INSTRUCTION}\n\n` +
    `${CHAT_INTERACTION_INSTRUCTION}\n\n` +
    `## 上下文区块与记忆\n${REPLY_CONTEXT_STRUCTURE_INSTRUCTION}\n` +
    `${TRANSCRIPT_FORMAT_INSTRUCTION}\n${CHAT_MEMORY_PRIORITY_INSTRUCTION}\n` +
    `${DIRECT_INVOCATION_READING_INSTRUCTION}\n${MEMORY_MECHANISM_SILENCE_INSTRUCTION}\n\n` +
    `## 行动与停止\n${actionInstruction}\n\n` +
    `## 联网查证\n${functionSearch ? WEB_SEARCH_FUNCTION_INSTRUCTION : WEB_SEARCH_INSTRUCTION}`;
}

/** 单轮回复内跨工具轮累积的调用计数。 */
interface ReplyCallCounters {
  /** 计入 grounded 与检索软额度的次数：服务端内建检索加本地 web_search 函数的实际检索。 */
  webSearchCalls: number;
  /** 本轮函数调用总数，含超出整轮预算、只拿到「预算耗尽」的调用。 */
  customToolCalls: number;
  /** 按函数名的调用次数，只用于诊断日志。 */
  readonly customToolCallsByName: Map<string, number>;
}

/**
 * 按模型调用顺序执行或接纳一轮函数调用，返回喂回模型的工具输出列表；本轮作废或 abuse_mark 已接纳并终止本轮时返回 null。
 *
 * @param functionCalls 模型在当前轮产出的函数调用列表
 * @param toolset 本轮回复的工具集执行器
 * @param counters 跨工具轮累积的调用计数器
 * @returns 供下一轮模型消费的工具输出列表；本轮已作废或被 `abuse_mark` 终止时返回 null
 */
async function runFunctionCalls(
  functionCalls: readonly AiFunctionCall[],
  toolset: ReplyToolset,
  counters: ReplyCallCounters
): Promise<AiToolOutput[] | null> {
  const outputs: AiToolOutput[] = [];
  for (const call of functionCalls) {
    if (!toolset.isActive()) return null;
    counters.customToolCalls++;
    const perNameCalls: number = (counters.customToolCallsByName.get(call.name) ?? 0) + 1;
    counters.customToolCallsByName.set(call.name, perNameCalls);
    const withinBudget: boolean = counters.customToolCalls <= MAX_CUSTOM_TOOL_CALLS_PER_REPLY;
    let toolResult: string;
    if (!withinBudget) {
      toolResult = TOOL_BUDGET_EXHAUSTED_RESULT;
    } else if (call.name === WEB_SEARCH_TOOL && toolset.searchWeb !== null) {
      const outcome: WebSearchToolOutcome = await toolset.searchWeb(call.argumentsJson);
      if (!toolset.isActive()) return null;
      counters.webSearchCalls += outcome.searchCalls;
      toolResult = outcome.result;
    } else {
      toolResult = toolset.has(call.name)
        ? toolset.execute(call.name, call.argumentsJson)
        : callTool(call.name);
      if (call.name === ABUSE_MARK_TOOL && parseToolResult(toolResult).error === null) {
        return null;
      }
    }
    outputs.push({ call, responseJson: toolResult });
  }
  return outputs;
}

/**
 * 执行一轮完整的模型回复对话，返回模型最终轮正文；请求失败、异常结束、工具无法续接、本轮作废或 abuse_mark 被接纳时返回 null。
 *
 * @param chatId 群聊 ID
 * @param promptSections 本轮组装好的参考记忆、当前对话与回复任务分段
 * @param toolset 本轮回复的工具集与生命周期句柄
 * @returns 模型最终轮输出的正文文本；无正文或本轮提前终止时返回 null
 */
export async function generateReply(
  chatId: number,
  promptSections: ReplyPromptSections,
  toolset: ReplyToolset
): Promise<string | null> {
  if (!toolset.isActive()) return null;
  const staticSystemPrompt: string = buildReplySystemPrompt(toolset);

  const session: AiReplySession = textAiProvider().createReplySession({
    chatId,
    stableBlocks: [promptSections.referenceMemory],
    volatileBlocks: [
      promptSections.currentConversation,
      buildRuntimeStateBlock(toolset.toolStatus),
      promptSections.replyTask,
    ],
    conversationSettledOffsets: promptSections.currentConversationSettledOffsets,
    signal: toolset.signal,
  });

  const counters: ReplyCallCounters = {
    webSearchCalls: 0,
    customToolCalls: 0,
    customToolCallsByName: new Map<string, number>(),
  };
  let searchDisabledByFallback: boolean = false;

  for (let round: number = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (!toolset.isActive()) return null;
    const webSearchEnabled: boolean = toolset.webSearch && !searchDisabledByFallback;

    toolset.beforeModelRequest();
    const turn: AiReplyTurn = await session.request({
      systemPrompt: staticSystemPrompt,
      functions: toolset.functions,
      webSearchEnabled,
      grounded: counters.webSearchCalls > 0,
    });
    if (!toolset.isActive()) return null;

    if (!turn.ok) {
      logger.error(
        `AI reply unusable response for chat ${chatId}: round=${round}, ` +
        `custom_calls=${counters.customToolCalls}, per_tool=${toolCountsDiagnostic(counters.customToolCallsByName)}, ` +
        `server_tool_invocations=${turn.webSearchCalls}, ` +
        `${diagnosticWithDetails(`finish_reason=${turn.finishReason ?? "?"}`, turn.finishDetails)}, ` +
        `side_effects=${toolset.actionsUsed()}.`
      );
      if (turn.toolCallLimitHit && webSearchEnabled && toolset.actionsUsed() === 0) {
        searchDisabledByFallback = true;
        logger.error(
          `AI reply hit the provider's server-side tool-call limit for chat ${chatId}; retrying once with web search disabled.`
        );
        continue;
      }
      return null;
    }

    if (turn.webSearchCalls > 0) {
      const previousCalls: number = counters.webSearchCalls;
      counters.webSearchCalls += turn.webSearchCalls;
      if (previousCalls <= MAX_WEB_SEARCH_CALLS_PER_REPLY && counters.webSearchCalls > MAX_WEB_SEARCH_CALLS_PER_REPLY) {
        logger.error(
          `AI reply exceeded the soft web search budget for chat ${chatId}: ` +
          `${counters.webSearchCalls} server-side call(s) against a budget of ${MAX_WEB_SEARCH_CALLS_PER_REPLY}.`
        );
      }
    }

    const functionCalls: readonly AiFunctionCall[] = turn.functionCalls;
    if (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      const outputs: AiToolOutput[] | null = await runFunctionCalls(functionCalls, toolset, counters);
      if (outputs === null) return null;
      if (!session.appendToolOutputs(outputs)) {
        logger.error(
          `AI reply session could not continue after tool outputs for chat ${chatId}: round=${round}, ` +
          `custom_calls=${counters.customToolCalls}, side_effects=${toolset.actionsUsed()}.`
        );
        return null;
      }
      continue;
    }

    if (functionCalls.length > 0) {
      logger.error(`AI reply for chat ${chatId} hit the tool-round limit (${MAX_TOOL_ROUNDS}) with ${functionCalls.length} unexecuted tool call(s); ending the round.`);
    }

    return turn.text;
  }

  return null;
}
