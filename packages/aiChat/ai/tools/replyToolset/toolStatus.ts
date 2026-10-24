/**
 * 本轮工具状态区块组装：按固定顺序（生图 → 语音 → 问答 → 独立检索）输出各工具在当前轮次的可用性快照。
 * 前缀缓存约束见 docs/cn/04-invariants.md。
 */

import {
  groupQaToolStatus,
  IMAGE_REFERENCE_ABSENT,
  IMAGE_TOOL_STATUS_UNAUTHORIZED,
  imageReferencePresent,
  imageToolStatusAvailable,
  imageToolStatusCoolingDown,
  TOOL_STATUS_BLOCK_LABEL,
  voiceToolStatus,
  webSearchToolStatus,
} from "../../../../consts/aiChat/prompts/tools";
import { agentTtsConfig } from "../../../../config/agent";
import { getImageGenerationAvailability } from "../../../../cache/workers/aiChat/imageGeneration";
import { aiTtsRemaining } from "../../ttsUsage";
import { ttsQuotaLimit } from "../../utils/ttsUsageWindow";
import { defaultAspectRatioFor, imageCooldownRetrySeconds } from "./imageGeneration";
import type { AgentTtsCapabilityConfig } from "../../../../types/config";
import type { CooldownAvailability } from "../../../../types/cooldown";
import type { ReplyToolContext } from "../../../../types/aiChat/replies";
import type { TelegramVisionSource } from "../../../../types/media";

/** 本模块从本轮回复上下文里真正读到的字段。 */
export type ToolStatusContext = Pick<
  ReplyToolContext,
  "chatId" | "chatQaCount" | "mediaToolsRequested" | "imageGenerationReferences" | "bypassMediaToolCooldown"
>;

/** buildToolStatusBlock 的入参：上下文子集、媒体能力与独立检索的本轮配置上限。 */
export interface ToolStatusParams {
  /** 本轮回复上下文中与工具状态相关的字段子集。 */
  readonly ctx: ToolStatusContext;
  /** 部署是否配置了生图能力（启用时 `generate_image` 工具始终挂载）。 */
  readonly imageEnabled: boolean;
  /** 部署是否配置了语音合成且供应商实现支持该能力（启用时 `send_voice` 工具始终挂载）。 */
  readonly voiceEnabled: boolean;
  /** 配置了独立 `web_search` 能力时的单轮调用上限；缺省表示使用 `text` 内建检索，不输出独立检索状态行。 */
  readonly webSearchMaxCallsPerUse?: number;
}

/**
 * 组装生图工具状态行：先检查本轮媒体工具触发资格，再检查群级生图冷却，均通过后输出参考图画幅或无参考图说明。
 * @param ctx 本轮回复上下文子集。
 * @returns 生图工具在当前轮次的可用性状态行。
 */
function imageStatusLine(ctx: ToolStatusContext): string {
  if (!ctx.mediaToolsRequested) return IMAGE_TOOL_STATUS_UNAUTHORIZED;
  const availability: CooldownAvailability = getImageGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassMediaToolCooldown,
  });
  if (!availability.allowed) {
    return imageToolStatusCoolingDown(imageCooldownRetrySeconds(availability.retryAfterMs));
  }
  const references: readonly TelegramVisionSource[] | undefined = ctx.imageGenerationReferences;
  const primary: TelegramVisionSource | undefined = references?.[0];
  return imageToolStatusAvailable(references !== undefined && primary !== undefined
    ? imageReferencePresent({
      count: references.length,
      width: primary.width,
      height: primary.height,
      defaultAspectRatio: defaultAspectRatioFor(primary),
    })
    : IMAGE_REFERENCE_ABSENT);
}

/**
 * 语音行：按当前 `agent.tts` 的 `ai` 口径上限给出剩余次数。
 * @returns 语音合成工具在当前轮次的剩余额度状态行。
 */
function voiceStatusLine(): string {
  const tts: AgentTtsCapabilityConfig | undefined = agentTtsConfig();
  return voiceToolStatus(aiTtsRemaining(), tts === undefined ? 0 : ttsQuotaLimit(tts, "ai"));
}

/**
 * 拼出本轮工具状态段（含段首标签），交给运行时状态区块。
 * @param params 工具状态上下文子集及各项媒体与检索能力开关。
 * @returns 包含段首标签与各工具状态行的完整文本区块。
 */
export function buildToolStatusBlock({ ctx, imageEnabled, voiceEnabled, webSearchMaxCallsPerUse }: ToolStatusParams): string {
  let block: string = TOOL_STATUS_BLOCK_LABEL;
  if (imageEnabled) block += "\n" + imageStatusLine(ctx);
  if (voiceEnabled) block += "\n" + voiceStatusLine();
  block += "\n" + groupQaToolStatus(ctx.chatQaCount ?? 0);
  if (webSearchMaxCallsPerUse !== undefined) block += "\n" + webSearchToolStatus(webSearchMaxCallsPerUse);
  return block;
}
