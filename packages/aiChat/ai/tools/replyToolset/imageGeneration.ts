import type { AiImageProvider, AiToolDefinition } from "../../../../types/aiChat/provider";
import { parseToolArguments } from "../../utils/toolArgs";
import {
  claimImageGeneration,
  getImageGenerationAvailability,
  releaseImageGenerationClaim,
} from "../../../../cache/workers/aiChat/imageGeneration";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS,
  IMAGE_GENERATION_PROMPT_MAX_CHARS,
  MAX_GENERATED_IMAGES_PER_REPLY,
} from "../../../../consts/aiChat/imageGeneration";
import {
  GENERATE_IMAGE_TOOL_INSTRUCTION,
  IMAGE_REFERENCE_POINTER,
} from "../../../../consts/aiChat/prompts/tools";
import { REPLY_CONTEXT_SECTION_NAMES } from "../../../../consts/aiChat/prompts/memory";
import { imageSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import {
  HARD_MAX_ACTIONS_PER_REPLY,
  IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS,
} from "../../../../consts/aiChat/tools";
import { TELEGRAM_CAPTION_MAX_CHARS, TELEGRAM_MESSAGE_MAX_CHARS } from "../../../../consts/telegram";
import { GENERATE_IMAGE_TOOL, REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { sendPhotoWithResult } from "../../../../infra/telegram";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import type { ReplyActionPause, ReplyToolContext, ReplyToolExecution, RoundMessageState } from "../../../../types/aiChat/replies";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type {
  GeneratedChatImage,
  ImageGenerationAspectRatio,
} from "../../../../types/aiChat/imageGeneration";
import type { CooldownAvailability, CooldownClaim } from "../../../../types/cooldown";
import type { TelegramPhotoSendResult } from "../../../../types/telegram";
import { imageAiProvider } from "../../../provider";
import { normalizeImageAspectRatio } from "../../utils/aspectRatio";
import { downloadTelegramVisionImage } from "../../telegramImage";
import { mediaTaskRunner } from "../../../../cache/workers/aiChat/mediaTasks";
import type { TelegramVisionSource, VisionImage } from "../../../../types/media";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../../consts/aiChat/media";
import { logger } from "../../../../infra/logger";
import { cleanReply } from "../../utils/replyText";
import { typingDelayMs } from "../../utils/timing";
import { acceptRoundText, sendDirectMessage } from "./messageState";
import { modelAuthoredTextPolicyResult } from "./modelAuthoredText";
import { pauseThenSettle } from "./pacing";

/**
 * 省略 aspect_ratio 时的默认比例：有主参考图时取最接近其尺寸的官方比例，否则返回 DEFAULT_IMAGE_GENERATION_ASPECT_RATIO。
 * @param reference 首张参考图的视觉素材尺寸元数据；无参考图时为 undefined。
 * @returns 默认生图宽高比。
 */
export function defaultAspectRatioFor(reference: TelegramVisionSource | undefined): ImageGenerationAspectRatio {
  if (!reference || reference.width <= 0 || reference.height <= 0) return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  return normalizeImageAspectRatio(`${reference.width}:${reference.height}`) ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}

/**
 * 构造 generate_image 工具声明；前缀缓存与资格约束见 docs/cn/04-invariants.md。
 * @returns generate_image 工具定义对象。
 */
export function buildGenerateImageToolDefinition(): AiToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL,
    description: `${GENERATE_IMAGE_TOOL_INSTRUCTION}\n${IMAGE_REFERENCE_POINTER}`,
    parametersJsonSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          maxLength: IMAGE_GENERATION_PROMPT_MAX_CHARS,
          description: "交给图片模型的完整独立画面提示词，应包含主体、场景、构图、风格、光线和需要呈现的文字。",
        },
        aspect_ratio: {
          type: "string",
          description:
            `群友要求的宽高比，例如 16:9、7:5 或 1920x1080；省略则按 ${REPLY_CONTEXT_SECTION_NAMES.runtimeState} 区块给出的默认比例。` +
            `官方比例为 ${IMAGE_GENERATION_ASPECT_RATIOS.join("、")}，` +
            "其它有效比例会由执行侧自动换成最接近的官方比例。",
        },
        caption: {
          type: "string",
          maxLength: TELEGRAM_MESSAGE_MAX_CHARS,
          description:
            "随图一起发出的图注：连图带话是同一条消息，不用再单独调用 send_message 说一遍。" +
            "写你想对群友说的原话，不要写画面描述或对工具的解释——画面说明属于 prompt。" +
            `没什么要说的就省略，只发图。尽量控制在 ${TELEGRAM_CAPTION_MAX_CHARS} 字以内；` +
            "超出这个长度 Telegram 不允许挂在图上，执行侧会自动拆成「图 + 一条独立文字消息」两条发出，多占一个动作。",
        },
      },
      required: ["prompt"],
    },
  };
}

/** 解析后的生图入参；caption 已走过 send_message 同一套正文清洗，缺省为 null。 */
interface ParsedImageArguments {
  prompt: string;
  aspectRatio: ImageGenerationAspectRatio;
  caption: string | null;
}

/**
 * 解析并校验 generate_image 工具参数。
 * @param argumentsJson 模型传入的工具参数 JSON 字符串。
 * @param defaultAspectRatio 未指定比例时使用的默认宽高比。
 * @returns 解析后的提示词、宽高比与可选清洗后图注；参数不合法时返回 null。
 */
function parseArguments(
  argumentsJson: string,
  defaultAspectRatio: ImageGenerationAspectRatio
): ParsedImageArguments | null {
  const parsed: Record<string, unknown> | null = parseToolArguments(argumentsJson);
  if (parsed === null || typeof parsed.prompt !== "string") return null;
  const prompt: string = parsed.prompt.trim();
  if (!prompt || prompt.length > IMAGE_GENERATION_PROMPT_MAX_CHARS) return null;
  if (parsed.aspect_ratio !== undefined && typeof parsed.aspect_ratio !== "string") return null;
  if (parsed.caption !== undefined && parsed.caption !== null && typeof parsed.caption !== "string") return null;
  const requestedAspectRatio: string | undefined = parsed.aspect_ratio;
  const aspectRatio: ImageGenerationAspectRatio | null = requestedAspectRatio === undefined || requestedAspectRatio.trim() === ""
    ? defaultAspectRatio
    : normalizeImageAspectRatio(requestedAspectRatio);
  const caption: string | null = typeof parsed.caption === "string" ? cleanReply(parsed.caption) : null;
  return aspectRatio ? { prompt, aspectRatio, caption } : null;
}

/**
 * 将生图冷却剩余毫秒数向上取整为秒数。
 * @param retryAfterMs 剩余冷却毫秒数。
 * @returns 向上取整后的剩余冷却秒数。
 */
export function imageCooldownRetrySeconds(retryAfterMs: number): number {
  return Math.ceil(retryAfterMs / 1_000);
}

/**
 * 构造生图冷却未过时的工具错误回执。
 * @param retryAfterMs 剩余冷却毫秒数。
 * @returns 指示模型告知群友冷却剩余时间的工具错误 JSON。
 */
function coolingDownError(retryAfterMs: number): string {
  const retryAfterSeconds: number = imageCooldownRetrySeconds(retryAfterMs);
  return toolError("Image generation is cooling down in this chat", {
    retry_after_seconds: retryAfterSeconds,
    retryable: false,
    required_action:
      `必须使用 send_message 明确告诉群友当前暂时不能使用生图，请约 ${retryAfterSeconds} 秒后再试；` +
      "本轮不要再次调用 generate_image。",
  });
}

/** 生图结果回执里 caption_delivery 的取值。 */
type ImageCaptionDelivery = "inline" | "separate_message" | "failed" | "no_action_budget";

/**
 * 下载本轮全部参考图（交互档并发，继承本轮取消信号）；任一张失败或总字节数超过
 * MEDIA_MAX_DOWNLOAD_BYTES 时返回 null。
 * @param ctx 当前回复轮次的工具共享上下文。
 * @param references 待下载的参考图素材列表。
 * @returns 下载并规范化后的参考图数组；任一张失败或总大小超限时返回 null。
 */
async function downloadReferenceImages(
  ctx: ReplyToolContext,
  references: readonly TelegramVisionSource[]
): Promise<VisionImage[] | null> {
  const downloads: PromiseSettledResult<VisionImage | null | undefined>[] = await Promise.allSettled(
    references.map((reference: TelegramVisionSource): Promise<VisionImage | null | undefined> => mediaTaskRunner.run(
      "interactive",
      (): Promise<VisionImage | null> => downloadTelegramVisionImage({
        fileId: reference.fileId,
        logLabel: "image generation reference",
        signal: ctx.signal,
      }),
      ctx.signal
    ))
  );
  const images: VisionImage[] = [];
  let totalBytes: number = 0;
  for (const download of downloads) {
    if (download.status !== "fulfilled" || !download.value) return null;
    totalBytes += download.value.bytes.byteLength;
    images.push(download.value);
  }
  if (totalBytes > MEDIA_MAX_DOWNLOAD_BYTES) {
    logger.error(`Image generation reference images exceeded the combined size limit (${totalBytes} bytes).`);
    return null;
  }
  return images;
}

/** deliverSeparateCaption 的入参。 */
interface SeparateCaptionParams {
  /** 当前回复轮次的工具共享上下文。 */
  readonly ctx: ReplyToolContext;
  /** 超出图注长度上限、需单独补发的图注文本。 */
  readonly caption: string;
  /** 聊天状态控制器。 */
  readonly chatAction: ChatActionControl;
  /** 拟人停顿控制函数。 */
  readonly pause: ReplyActionPause;
}

/**
 * 图片发出后按打字节奏停顿并补发超长图注。
 * @param params 工具上下文、超长图注文本及聊天状态与停顿控制。
 * @returns 补发成功时返回 `"separate_message"`，停顿作废或发送失败时返回 `"failed"`。
 */
async function deliverSeparateCaption({
  ctx,
  caption,
  chatAction,
  pause,
}: SeparateCaptionParams): Promise<"separate_message" | "failed"> {
  chatAction.set("idle");
  const blocked: string | null = await pauseThenSettle({
    isActive: ctx.isActive,
    chatAction,
    pause,
    phase: "typing",
    delayMs: typingDelayMs(caption),
  });
  if (blocked !== null) return "failed";
  const captionMessageId: number | undefined = await sendDirectMessage({
    ctx,
    text: caption,
    replyToMessageId: ctx.replyToMessageId,
  });
  return captionMessageId === undefined ? "failed" : "separate_message";
}

/**
 * 创建 generate_image 执行器：接纳时校验资格、参数、图注策略并认领群冷却；串行步骤中下载参考图、
 * 调用生图模型并发送图片与图注，未发起模型请求时释放冷却认领。生命周期见 docs/cn/04-invariants.md。
 * @param ctx 当前回复轮次的工具共享上下文。
 * @param state 本轮消息去重与错字状态。
 * @param getActionsUsed 读取本轮已占用动作额度的回调。
 * @returns 接收参数 JSON 并返回生图工具执行计划的执行器函数。
 */
export function createGenerateImageExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState,
  getActionsUsed: () => number
): (argumentsJson: string) => ReplyToolExecution {
  let acceptedImages: number = 0;
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (!ctx.mediaToolsRequested) {
      return toolError(
        "Image generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        { retryable: false }
      );
    }
    if (acceptedImages >= MAX_GENERATED_IMAGES_PER_REPLY) {
      return toolError(
        `Image limit reached: at most ${MAX_GENERATED_IMAGES_PER_REPLY} generated image per reply`,
        { retryable: false }
      );
    }
    const availability: CooldownAvailability = getImageGenerationAvailability({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!availability.allowed) return coolingDownError(availability.retryAfterMs);
    const references: readonly TelegramVisionSource[] | undefined = ctx.imageGenerationReferences;
    const parsed: ParsedImageArguments | null = parseArguments(argumentsJson, defaultAspectRatioFor(references?.[0]));
    if (!parsed) {
      return toolError(
        "Invalid image arguments: prompt must be non-empty, aspect_ratio must look like W:H, W/H, WxH, or W×H, and caption must be a string"
      );
    }
    const caption: string | null = parsed.caption;
    if (caption !== null) {
      const policyResult: string | null = modelAuthoredTextPolicyResult(caption, state, "picture");
      if (policyResult !== null) return policyResult;
    }

    const claim: CooldownClaim = claimImageGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!claim.allowed) return coolingDownError(claim.retryAfterMs);
    acceptedImages++;
    const inlineCaption: string | null =
      caption !== null && caption.length <= TELEGRAM_CAPTION_MAX_CHARS ? caption : null;
    const captionBudgetLeft: boolean =
      HARD_MAX_ACTIONS_PER_REPLY - getActionsUsed() >= IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS;
    const separateCaption: boolean = caption !== null && inlineCaption === null && captionBudgetLeft;
    if (caption !== null && (inlineCaption !== null || separateCaption)) acceptRoundText(state, caption);
    return {
      result: JSON.stringify({
        success: true,
        queued: true,
        actions_used: separateCaption ? 2 : 1,
        aspect_ratio: parsed.aspectRatio,
        caption_delivery: caption === null
          ? undefined
          : inlineCaption !== null ? "inline" : separateCaption ? "separate_message" : "no_action_budget",
      }),
      run: async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
        let modelRequestStarted: boolean = false;
        try {
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
          chatAction.set("upload_photo");
          let image: GeneratedChatImage | null = null;
          let referenceUnavailable: boolean = false;
          try {
            const referenceImages: VisionImage[] | null = references === undefined
              ? []
              : await downloadReferenceImages(ctx, references);
            referenceUnavailable = referenceImages === null;
            if (referenceImages !== null && ctx.isActive()) {
              modelRequestStarted = true;
              const provider: AiImageProvider | null = imageAiProvider();
              image = provider === null ? null : await provider.generateImage({
                prompt: parsed.prompt,
                aspectRatio: parsed.aspectRatio,
                referenceImages,
                signal: ctx.signal,
              });
            }
          } finally {
            chatAction.set("idle");
            await chatAction.settle();
          }
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
          if (referenceUnavailable) {
            return toolError("Failed to load the reference images from Telegram");
          }
          if (!image) {
            return toolError("Image generation failed or returned no usable image", {
              retryable: false,
            });
          }

          const sent: TelegramPhotoSendResult | undefined = await sendPhotoWithResult({
            chatId: ctx.chatId,
            bytes: image.bytes,
            mimeType: image.mimeType,
            replyToMessageId: ctx.replyToMessageId,
            signal: ctx.signal,
            messageThreadId: ctx.messageThreadId,
            caption: inlineCaption ?? undefined,
          });
          if (sent === undefined) {
            return toolError("Failed to send generated image", { retryable: false });
          }

          const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS);
          const imageTag: string = imageSentTagTemplate(memoryPrompt, references !== undefined);

          ctx.onImageSent({
            text: inlineCaption !== null ? `${imageTag}${inlineCaption}` : imageTag,
            messageId: sent.messageId,
            repliedToMessageId: sent.repliedToMessageId,
            origin: references !== undefined ? "referenceGenerated" : "generated",
            caption: inlineCaption ?? "",
            photo: sent.photo,
          });

          const captionDelivery: ImageCaptionDelivery | null = caption === null
            ? null
            : inlineCaption !== null
              ? "inline"
              : separateCaption
                ? await deliverSeparateCaption({ ctx, caption, chatAction, pause })
                : "no_action_budget";

          return JSON.stringify({
            success: true,
            message_id: sent.messageId,
            aspect_ratio: parsed.aspectRatio,
            actions_used: captionDelivery === "separate_message" ? 2 : 1,
            caption_delivery: captionDelivery ?? undefined,
            reference_images_used: references?.length,
          });
        } finally {
          if (!modelRequestStarted) releaseImageGenerationClaim(ctx.chatId, claim.token);
        }
      },
    };
  };
}
