/**
 * 主线程转交的语音合成（`/send` 代发 TTS 与 cron `send_voice`）在 AI Worker 侧的执行：
 * 按 `operator` 配额合成并编码语音，通过 `voiceSynthesized` 回执返回结果并转移音频字节 buffer。
 */

import { voiceSynthesisRequests } from "../../cache/workers/aiChat/voiceSynthesis";
import { logger } from "../../infra/logger";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../aiChat/ai/voiceSynthesis";
import type {
  AiCancelVoiceSynthesisMessage,
  AiSynthesizeVoiceMessage,
  AiVoiceSynthesizedEvent,
} from "../../types/aiChat/protocol";
import type { SpeechSynthesizerLookup, VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";
import { runAiWorkerJob } from "./workerJob";

declare const self: Worker;

/** 查找语音合成入口并执行合成；能力缺席或异常时返回失败结果。 */
async function synthesize(msg: AiSynthesizeVoiceMessage, signal: AbortSignal): Promise<VoiceSynthesisResult> {
  let synthesizer: SpeechSynthesizerLookup;
  try {
    synthesizer = resolveSpeechSynthesizer();
  } catch (error: unknown) {
    logger.error(`Speech synthesizer lookup for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "synthesis failed" };
  }
  if (!synthesizer.ok) return { ok: false, reason: synthesizer.reason };
  return await synthesizeVoiceMessage(
    synthesizer.synthesize,
    { text: msg.text, tone: msg.tone, quota: "operator", signal },
    `main-thread request ${msg.requestId}`
  );
}

/** 接纳一次合成请求；结算后回执，成功时转移语音字节的底层 buffer。 */
export function handleSynthesizeVoice(msg: AiSynthesizeVoiceMessage): void {
  runAiWorkerJob<VoiceSynthesisResult>({
    jobs: voiceSynthesisRequests,
    requestId: msg.requestId,
    run: (signal: AbortSignal): Promise<VoiceSynthesisResult> => synthesize(msg, signal),
    publish: (result: VoiceSynthesisResult): void => {
      const event: AiVoiceSynthesizedEvent = { type: "voiceSynthesized", requestId: msg.requestId, result };
      if (result.ok) self.postMessage(event, [result.voice.bytes.buffer]);
      else self.postMessage(event);
    },
  });
}

/** 撤回一次在途合成；已结算或未知的 requestId 不做任何事。 */
export function handleCancelVoiceSynthesis(msg: AiCancelVoiceSynthesisMessage): void {
  voiceSynthesisRequests.get(msg.requestId)?.abort();
}
