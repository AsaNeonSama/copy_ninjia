/**
 * 群聊语音消息下载与供应商语音转写调用。
 */

import { logger } from "../../infra/logger";
import { mediaAiProvider } from "../provider";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { VOICE_TRANSCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import {
  VOICE_TRANSCRIPT_MAX_CHARS,
  VOICE_TRANSCRIPTION_ERROR_LABEL,
} from "../../consts/aiChat/voice";
import { downloadTelegramVoice } from "./telegramAudio";
import type { AiMediaProvider, AiTextResult, AiVoiceRequest } from "../../types/aiChat/provider";
import type { VoiceClip } from "../../types/media";

/** transcribeVoiceUncached 的入参。 */
export interface TranscribeVoiceParams {
  fileId: string;
  /** Telegram 声明的 mime_type。 */
  declaredMime: string | undefined;
  signal?: AbortSignal;
}

/**
 * 下载并转写单条语音（不经缓存）；下载失败返回可重采样失败，供应商不支持时返回 unsupported。
 */
export async function transcribeVoiceUncached({
  fileId,
  declaredMime,
  signal,
}: TranscribeVoiceParams): Promise<AiTextResult> {
  try {
    const provider: AiMediaProvider = mediaAiProvider();
    const transcribe: ((request: AiVoiceRequest) => Promise<AiTextResult>) | undefined = provider.transcribeVoice;
    if (transcribe === undefined) {
      logger.error(`Voice transcription is unavailable: the ${provider.name} media provider does not implement it.`);
      return { ok: false, retryable: false, mediaFailure: "unsupported" };
    }
    const clip: VoiceClip | null = await downloadTelegramVoice({
      fileId,
      declaredMime,
      signal,
    });
    if (!clip) return { ok: false, retryable: true };
    return await transcribe({
      prompt: VOICE_TRANSCRIPTION_PROMPT,
      clip,
      signal,
      errorLabel: VOICE_TRANSCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const transcript: string = sanitizeInline(text);
        if (!transcript) return "";
        return truncateAtClauseBoundary(transcript, VOICE_TRANSCRIPT_MAX_CHARS);
      },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) return { ok: false, retryable: false };
    logger.error("Error transcribing chat voice:", error);
    return { ok: false, retryable: false };
  }
}
