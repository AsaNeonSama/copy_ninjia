import type { AiToolDefinition, AiWebSearchFacade } from "../../../../types/aiChat/provider";
import { HARD_MAX_ACTIONS_PER_REPLY } from "../../../../consts/aiChat/tools";
import {
  ABUSE_MARK_TOOL,
  ACTION_TOOL_NAMES,
  REPLY_INVALIDATED_TOOL_ERROR,
  TOOL_DECLARATIONS,
  ADD_REACTION_TOOL,
  GENERATE_IMAGE_TOOL,
  GET_TOKYO_WEATHER_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_MESSAGE_TOOL,
  SEND_STICKER_TOOL,
  SEND_VOICE_TOOL,
  unknownToolError,
  VIEW_STICKER_PACK_TOOL,
  WEB_SEARCH_TOOL_DECLARATION,
} from "../../../../consts/tools";
import type {
  DirectReplyPacing,
  ReplyActionChains,
  ReplyToolContext,
  ReplyToolExecution,
  ReplyToolset,
  RoundMessageState,
  WebSearchToolExecutor,
} from "../../../../types/aiChat/replies";
import type { StickerPackCandidate, StickerRoundState } from "../../../../types/stickers/tools";
import {
  buildSendStickerToolDefinition,
  buildStickerPackMenu,
  buildViewStickerPackToolDefinition,
  createStickerRoundState,
  sendStickerTool,
  viewStickerPackTool,
} from "../stickers";
import { createAbuseMarkExecutor } from "./abuseMark";
import { buildGenerateImageToolDefinition, createGenerateImageExecutor } from "./imageGeneration";
import { buildToolStatusBlock } from "./toolStatus";
import { buildSendVoiceToolDefinition, createSendVoiceExecutor, isSendVoiceAvailable } from "./voiceMessage";
import {
  buildAbuseMarkToolDefinition,
  buildAddReactionToolDefinition,
  buildSendMessageToolDefinition,
} from "./definitions";
import { createRoundMessageState } from "./messageState";
import { createAddReactionExecutor } from "./reaction";
import { createSendMessageExecutor } from "./sendMessage";
import {
  buildGroupQaToolDefinitions,
  executeGroupQaAnswer,
  executeGroupQaQuery,
} from "./groupQa";
import { parseToolResult, toolError } from "../../utils/toolResult";
import { imageAiProvider, webSearchAiProvider } from "../../../provider";
import { createWebSearchExecutor } from "../webSearch";
import { createReplyActionChains } from "./actionChains";
import { createDirectPacing } from "./pacing";
import { getAgentDeploymentConfig } from "../../../../config/agent";
import { getTimeZone } from "../../../../config/time";
import { TOKYO_TIME_ZONE } from "../../../../consts/time";
import { VOICE_LANGUAGE_PROMPTS } from "../../../../consts/aiChat/prompts/tools";
import { TTS_DEFAULT_BOT_LANGUAGE } from "../../../../consts/aiChat/voiceMessage";
import type { AgentDeploymentConfig } from "../../../../types/config";
import type { VoiceLanguagePrompts } from "../../../../types/aiChat/voiceMessage";

/**
 * 组装单轮回复的工具声明、领域执行器、本轮工具状态快照与共享动作预算。
 * 工具清单与前缀缓存约束见 docs/cn/04-invariants.md。
 */
export async function createReplyToolset(ctx: ReplyToolContext, deliveryReady?: Promise<void>): Promise<ReplyToolset> {
  const menu: readonly StickerPackCandidate[] = await buildStickerPackMenu(ctx.signal);
  const stickerState: StickerRoundState = createStickerRoundState();
  const messageState: RoundMessageState = createRoundMessageState();
  let actionsUsed: number = 0;
  const directPacing: DirectReplyPacing | null = ctx.direct ? createDirectPacing(ctx.chatAction, ctx.signal) : null;
  const chains: ReplyActionChains = createReplyActionChains(ctx, deliveryReady, directPacing);
  let choosingSticker: boolean = false;

  const viewDefinition: AiToolDefinition | null = buildViewStickerPackToolDefinition(menu);
  const sendStickerDefinition: AiToolDefinition | null = buildSendStickerToolDefinition(menu);
  const imageEnabled: boolean = imageAiProvider() !== null;
  const voiceEnabled: boolean = isSendVoiceAvailable();
  const webSearchProvider: AiWebSearchFacade | null = webSearchAiProvider();
  const deployment: AgentDeploymentConfig = getAgentDeploymentConfig();
  const webSearchMaxCallsPerUse: number | undefined = deployment.webSearch?.maxCallsPerUse;
  const voicePrompts: Readonly<VoiceLanguagePrompts> =
    VOICE_LANGUAGE_PROMPTS[deployment.tts?.botLanguage ?? TTS_DEFAULT_BOT_LANGUAGE];
  const declarations: AiToolDefinition[] = [
    buildSendMessageToolDefinition(voicePrompts.sendMessageInstruction),
  ];
  if (imageEnabled) declarations.push(buildGenerateImageToolDefinition());
  if (voiceEnabled) declarations.push(buildSendVoiceToolDefinition(voicePrompts));
  declarations.push(buildAddReactionToolDefinition());
  if (viewDefinition !== null) declarations.push(viewDefinition);
  if (sendStickerDefinition !== null) declarations.push(sendStickerDefinition);
  declarations.push(...buildGroupQaToolDefinitions());
  declarations.push(buildAbuseMarkToolDefinition());
  const names: Set<string> = new Set<string>();
  for (const declaration of declarations) names.add(declaration.name);
  const functions: AiToolDefinition[] = [];
  const tokyoWeatherEnabled: boolean = getTimeZone() === TOKYO_TIME_ZONE;
  for (const declaration of TOOL_DECLARATIONS) {
    if (declaration.name !== GET_TOKYO_WEATHER_TOOL || tokyoWeatherEnabled) functions.push(declaration);
  }
  if (webSearchProvider !== null) functions.push(WEB_SEARCH_TOOL_DECLARATION);
  functions.push(...declarations);
  const searchWeb: WebSearchToolExecutor | null = webSearchProvider === null
    ? null
    : createWebSearchExecutor(webSearchProvider, webSearchMaxCallsPerUse!, ctx.signal);

  const executeSendMessage: (argumentsJson: string) => ReplyToolExecution = createSendMessageExecutor(ctx, messageState, (): number => actionsUsed);
  const executeAddReaction: (argumentsJson: string) => ReplyToolExecution = createAddReactionExecutor(ctx);
  const executeAbuseMark: (argumentsJson: string) => ReplyToolExecution = createAbuseMarkExecutor(ctx);
  const executeGenerateImage: ((argumentsJson: string) => ReplyToolExecution) | null = imageEnabled
    ? createGenerateImageExecutor(ctx, messageState, (): number => actionsUsed)
    : null;
  const executeSendVoice: ((argumentsJson: string) => ReplyToolExecution) | null =
    voiceEnabled ? createSendVoiceExecutor(ctx, chains, voicePrompts.speechLanguageStyle) : null;

  /** 记录执行回执：动作工具累加已占动作数，接纳的动作排入串行链。 */
  function accept(name: string, isActionTool: boolean, execution: ReplyToolExecution): string {
    const result: string = typeof execution === "string" ? execution : execution.result;
    if (isActionTool) actionsUsed += parseToolResult(result).actionsUsed;
    if (typeof execution !== "string") chains.start(name, execution.run);
    return result;
  }

  function dispatch(name: string, argumentsJson: string): ReplyToolExecution {
    switch (name) {
      case SEND_MESSAGE_TOOL:
        return executeSendMessage(argumentsJson);
      case ADD_REACTION_TOOL:
        return executeAddReaction(argumentsJson);
      case ABUSE_MARK_TOOL:
        return executeAbuseMark(argumentsJson);
      case GENERATE_IMAGE_TOOL:
        return executeGenerateImage === null
          ? toolError(unknownToolError(name))
          : executeGenerateImage(argumentsJson);
      case SEND_VOICE_TOOL:
        return executeSendVoice === null
          ? toolError(unknownToolError(name))
          : executeSendVoice(argumentsJson);
      case GROUP_QA_QUERY_TOOL:
        return executeGroupQaQuery(ctx.chatQaJson);
      case GROUP_QA_ANSWER_TOOL:
        return executeGroupQaAnswer(ctx.chatQaJson, argumentsJson);
      case VIEW_STICKER_PACK_TOOL: {
        const viewedBefore: number = stickerState.viewedPackIntents.size;
        const result: string = viewStickerPackTool({
          menu,
          argumentsJson,
          state: stickerState,
          signal: ctx.signal,
        });
        if (stickerState.viewedPackIntents.size > viewedBefore) choosingSticker = true;
        return result;
      }
      case SEND_STICKER_TOOL:
        return sendStickerTool({
          chatId: ctx.chatId,
          messageThreadId: ctx.messageThreadId,
          menu,
          argumentsJson,
          state: stickerState,
          onSent: ctx.onStickerSent,
          isActive: ctx.isActive,
          signal: ctx.signal,
        });
      default:
        return toolError(unknownToolError(name));
    }
  }

  return {
    functions,
    toolStatus: buildToolStatusBlock({ ctx, imageEnabled, voiceEnabled, webSearchMaxCallsPerUse }),
    webSearch: webSearchProvider === null,
    searchWeb,
    replyActionInstruction: voicePrompts.replyActionInstruction,
    has: (name: string): boolean => names.has(name),
    beforeModelRequest: (): void => {
      if (directPacing === null || !ctx.isActive()) return;
      directPacing.beforeModelRequest(choosingSticker ? "choose_sticker" : actionsUsed === 0 ? "typing" : "idle");
      choosingSticker = false;
    },
    afterModel: (): void => {
      directPacing?.endModel();
    },
    execute: (name: string, argumentsJson: string): string => {
      if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      const isActionTool: boolean = ACTION_TOOL_NAMES.includes(name);
      if (isActionTool && actionsUsed >= HARD_MAX_ACTIONS_PER_REPLY) {
        return toolError(
          `Action limit reached: at most ${HARD_MAX_ACTIONS_PER_REPLY} actions (messages + stickers + reactions + images + voices) per reply`
        );
      }
      return accept(name, isActionTool, dispatch(name, argumentsJson));
    },
    actionsUsed: (): number => actionsUsed,
    settle: (): Promise<void> => chains.settle(),
    actionsCompleted: (): number => chains.completed(),
    isActive: ctx.isActive,
    signal: ctx.signal,
  };
}
