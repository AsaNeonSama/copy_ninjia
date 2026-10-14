/**
 * OpenAI 侧的生图实现：按 `imageProtocol` 分派到 OpenAI 原生或 xAI 协议（无参考图走 generate，有参考图走 edit），
 * 并按文件签名解码校验返回的 base64 图片载荷。
 */

import { toFile } from "openai";
import type OpenAI from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_IMAGE_ERROR_LABEL,
  OPENAI_IMAGE_MODERATION,
  OPENAI_IMAGE_OUTPUT_FORMAT,
  OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
  OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO,
  OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO,
  XAI_IMAGE_RESOLUTION,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportAiCacheUsage, reportXAiUsage } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { decodeGeneratedImageBySignature } from "../ai/utils/imagePayload";
import { getOpenAiClient } from "./client";
import type { AiImageRequest } from "../../types/aiChat/provider";
import type { AgentImageCapabilityConfig, OpenAiAgentImageCapabilityConfig, OpenAiImageProtocol } from "../../types/config";
import type {
  GeneratedChatImage,
  GeneratedImageDecodeResult,
  ImageGenerationAspectRatio,
} from "../../types/aiChat/imageGeneration";
import type { VisionImage } from "../../types/media";

/** xAI 协议支持的生图画幅比例。 */
type XAiImageAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "9:16" | "16:9" | "20:9";

/** OpenAI 原生生图协议档位。 */
type OpenAiNativeImageProtocol = Exclude<OpenAiImageProtocol, "xai">;

/** xAI generate 请求体。 */
interface XAiImageGenerateParams extends OpenAI.Images.ImageGenerateParamsNonStreaming {
  readonly model: string;
  readonly aspect_ratio: XAiImageAspectRatio;
  readonly resolution: string;
  readonly response_format: "b64_json";
  readonly n: 1;
}

/** xAI JSON edit 请求中的单张 data URI 图片输入。 */
interface XAiImageInput {
  readonly type: "image_url";
  readonly url: string;
}

/** xAI edit 请求体的公共字段。 */
interface XAiImageEditBaseParams {
  readonly model: string;
  readonly prompt: string;
  readonly resolution: string;
  readonly response_format: "b64_json";
}

/** 单张参考图的 xAI edit 请求体。 */
interface XAiSingleImageEditParams extends XAiImageEditBaseParams {
  readonly image: XAiImageInput;
}

/** 多张参考图的 xAI edit 请求体。 */
interface XAiMultiImageEditParams extends XAiImageEditBaseParams {
  readonly images: readonly XAiImageInput[];
}

/** 按 OpenAI 原生协议档位将领域画幅映射为尺寸字符串。 */
function pickOpenAiImageSize(
  protocol: OpenAiNativeImageProtocol,
  aspectRatio: ImageGenerationAspectRatio
): string {
  switch (protocol) {
    case "openai": return OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio];
    case "openai-standard": return OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO[aspectRatio];
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported native OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/** 将领域画幅比例映射为 xAI 支持的画幅比例。 */
function pickXAiAspectRatio(aspectRatio: ImageGenerationAspectRatio): XAiImageAspectRatio {
  switch (aspectRatio) {
    case "5:4": return "4:3";
    case "4:5": return "3:4";
    case "21:9": return "20:9";
    default: return aspectRatio;
  }
}

/** 将参考图包装为 SDK 可上传的文件句柄。 */
function toReferenceUpload(referenceImage: VisionImage, ordinal: number): Promise<Uploadable> {
  const extension: string = referenceImage.mime === "image/png" ? "png" : "jpg";
  return toFile(referenceImage.bytes, `reference-${ordinal}.${extension}`, { type: referenceImage.mime });
}

/** 将参考图编码为 xAI JSON edit 所需的 data URI 输入对象。 */
function toXAiImageInput(referenceImage: VisionImage): XAiImageInput {
  return { type: "image_url", url: `data:${referenceImage.mime};base64,${referenceImage.bytes.toBase64()}` };
}

/** 按配置的生图线协议发起一次生图或改图请求。 */
async function requestOpenAiCompatibleImage(
  config: OpenAiAgentImageCapabilityConfig,
  {
    prompt,
    aspectRatio,
    referenceImages,
  }: AiImageRequest,
  signal: AbortSignal
): Promise<OpenAI.Images.ImagesResponse> {
  const client: OpenAI = getOpenAiClient("image");
  const protocol: OpenAiImageProtocol = config.imageProtocol;
  const model: string = config.model;
  switch (protocol) {
    case "xai": {
      const firstReference: VisionImage | undefined = referenceImages[0];
      if (firstReference !== undefined) {
        const body: XAiSingleImageEditParams | XAiMultiImageEditParams = referenceImages.length === 1
          ? {
            model,
            prompt,
            image: toXAiImageInput(firstReference),
            resolution: XAI_IMAGE_RESOLUTION,
            response_format: "b64_json",
          }
          : {
            model,
            prompt,
            images: referenceImages.map(toXAiImageInput),
            resolution: XAI_IMAGE_RESOLUTION,
            response_format: "b64_json",
          };
        return client.post<OpenAI.Images.ImagesResponse>("/images/edits", {
          body,
          signal,
          timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
        });
      }
      const body: XAiImageGenerateParams = {
        model,
        prompt,
        aspect_ratio: pickXAiAspectRatio(aspectRatio),
        resolution: XAI_IMAGE_RESOLUTION,
        response_format: "b64_json",
        n: 1,
      };
      return client.images.generate(body, {
        signal,
        timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS,
      });
    }
    case "openai":
    case "openai-standard": {
      const size: string = pickOpenAiImageSize(protocol, aspectRatio);
      if (referenceImages.length > 0) {
        const uploads: Uploadable[] = [];
        for (const referenceImage of referenceImages) {
          uploads.push(await toReferenceUpload(referenceImage, uploads.length + 1));
        }
        signal.throwIfAborted();
        const [onlyUpload]: Uploadable[] = uploads;
        return client.images.edit(
          {
            model,
            image: uploads.length === 1 && onlyUpload !== undefined ? onlyUpload : uploads,
            prompt,
            size,
            output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
            n: 1,
          },
          { signal, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS }
        );
      }
      return client.images.generate(
        {
          model,
          prompt,
          size,
          output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
          moderation: OPENAI_IMAGE_MODERATION,
          n: 1,
        },
        { signal, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS }
      );
    }
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/** 生成用于错误日志的画幅描述字符串。 */
function imageCanvasForLog(
  protocol: OpenAiImageProtocol,
  aspectRatio: ImageGenerationAspectRatio,
  hasReferenceImage: boolean
): string {
  switch (protocol) {
    case "xai": return hasReferenceImage ? "follows-reference" : pickXAiAspectRatio(aspectRatio);
    case "openai":
    case "openai-standard": return pickOpenAiImageSize(protocol, aspectRatio);
    default: {
      const unhandledProtocol: never = protocol;
      throw new Error(`Unsupported OpenAI image protocol: ${String(unhandledProtocol)}`);
    }
  }
}

/**
 * 调用 OpenAI 兼容生图接口生成一张图片；请求失败或无可用载荷时记录日志并返回 null。
 */
export async function generateOpenAiImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
  const {
    aspectRatio,
    referenceImages,
    signal,
  }: AiImageRequest = request;
  try {
    signal?.throwIfAborted();
    const capabilityConfig: AgentImageCapabilityConfig | undefined = getAgentDeploymentConfig().image;
    if (capabilityConfig === undefined) {
      throw new Error('Agent capability "image" is not configured.');
    }
    if (capabilityConfig.provider !== "openai") {
      throw new Error('Agent capability "image" is not configured for the OpenAI provider.');
    }
    const config: OpenAiAgentImageCapabilityConfig = capabilityConfig;
    const model: string = config.model;
    const protocol: OpenAiImageProtocol = config.imageProtocol;
    const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
    requestSignal.throwIfAborted();
    const response: OpenAI.Images.ImagesResponse = await raceAbortOrThrow(
      requestOpenAiCompatibleImage(config, request, requestSignal)
        .then((result: OpenAI.Images.ImagesResponse): OpenAI.Images.ImagesResponse => {
          if (protocol === "xai") {
            reportXAiUsage({ capability: "image", model, usage: result.usage });
          } else {
            reportAiCacheUsage({
              capability: "image", provider: "openai", model,
              inputTokens: result.usage?.input_tokens,
              cachedInputTokens: undefined,
              outputTokens: result.usage?.output_tokens,
            });
          }
          return result;
        }),
      requestSignal
    );
    const entry: OpenAI.Images.Image | undefined = response.data?.[0];
    const encoded: string | undefined = entry?.b64_json;
    if (encoded === undefined) {
      const kind: string = entry === undefined
        ? "no entries"
        : (typeof entry.url === "string" ? "url envelope instead of base64" : "entry without b64_json");
      const canvas: string = imageCanvasForLog(protocol, aspectRatio, referenceImages.length > 0);
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned no usable image payload: ${kind} ` +
        `(entries=${response.data?.length ?? 0}, model=${model}, canvas=${canvas}, ` +
        `reference_images=${referenceImages.length}).`
      );
      return null;
    }
    const decoded: GeneratedImageDecodeResult = decodeGeneratedImageBySignature(encoded);
    if (!decoded.ok) {
      const canvas: string = imageCanvasForLog(protocol, aspectRatio, referenceImages.length > 0);
      logger.error(
        `${OPENAI_IMAGE_ERROR_LABEL} returned an unusable image payload: ${decoded.reason} ` +
        `(encoded_chars=${encoded.length}, canvas=${canvas}, reference_images=${referenceImages.length}).`
      );
      return null;
    }
    return decoded.image;
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error(`Error calling ${OPENAI_IMAGE_ERROR_LABEL}:`, error);
    return null;
  }
}
