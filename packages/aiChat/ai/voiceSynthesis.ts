/**
 * 语音合成入口解析与音频容器编码封装，供 AI 语音工具与主线程借用合成共用。
 */

import { logger } from "../../infra/logger";
import { ttsAiProvider } from "../provider";
import { encodeVoiceMessage } from "./voiceEncoding";
import type { AiMeteredSpeechRequest, AiSpeechFacade } from "../../types/aiChat/provider";
import type {
  SpeechSynthesisAttempt,
  SpeechSynthesizer,
  SpeechSynthesizerLookup,
  VoiceEncodeResult,
  VoiceSynthesisResult,
} from "../../types/aiChat/voiceMessage";

/** 解析当前配置的语音合成入口；未配置或所选供应商不支持时返回对应原因。 */
export function resolveSpeechSynthesizer(): SpeechSynthesizerLookup {
  const provider: AiSpeechFacade | null = ttsAiProvider();
  if (provider === null) return { ok: false, reason: "tts unconfigured", providerName: undefined };
  const synthesize: SpeechSynthesizer | undefined = provider.synthesizeSpeech;
  if (synthesize === undefined) return { ok: false, reason: "tts unsupported", providerName: provider.name };
  return { ok: true, synthesize };
}

/**
 * 调用语音合成入口并将返回的音频编码为 Telegram 语音消息载荷。合成返回后 request.signal 已中止时
 * 返回 aborted；编码期间的中止由 encodeVoiceMessage 返回 aborted，不记编码失败。
 */
export async function synthesizeVoiceMessage(
  synthesize: SpeechSynthesizer,
  request: AiMeteredSpeechRequest,
  logContext: string
): Promise<VoiceSynthesisResult> {
  try {
    const attempt: SpeechSynthesisAttempt = await synthesize(request);
    if (request.signal?.aborted === true) return { ok: false, reason: "aborted" };
    if (!attempt.ok) return attempt;
    const encoded: VoiceEncodeResult = await encodeVoiceMessage(attempt.speech, request.signal);
    if (!encoded.ok && encoded.reason !== "aborted") logger.error(`Voice message encoding failed (${logContext}): ${encoded.reason}.`);
    return encoded;
  } catch (error: unknown) {
    logger.error(`Voice synthesis failed unexpectedly (${logContext}):`, error);
    return { ok: false, reason: "synthesis failed" };
  }
}
