/**
 * 主线程向 AI Worker 发起语音合成请求的客户端入口。
 */

import { agentTtsConfig } from "../config/agent";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../consts/aiChat/voiceMessage";
import { voiceSynthesisRequests } from "../cache/main/aiChat";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";
import type { AiWorkerJobTransport } from "../types/aiChat/workerJob";
import { requestAiWorkerJob } from "./workerJob";

/** 交给 AI Worker 合成的一句台词。 */
export interface VoiceSynthesisRequest {
  readonly text: string;
  /** 附加在基础朗读风格后的本句语气；未指定时为 undefined。 */
  readonly tone: string | undefined;
  /** 调用方取消信号。 */
  readonly signal: AbortSignal | undefined;
}

/**
 * 请求 AI Worker 合成一句语音；未配置 `agent.tts` 或 Worker 不可用时直接返回对应失败原因。
 */
export function requestVoiceSynthesis(
  request: VoiceSynthesisRequest,
  transport: AiWorkerJobTransport
): Promise<VoiceSynthesisResult> {
  if (agentTtsConfig() === undefined) return Promise.resolve({ ok: false, reason: "tts unconfigured" });
  return requestAiWorkerJob<VoiceSynthesisResult>({
    table: voiceSynthesisRequests,
    timeoutMs: VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS,
    transport,
    signal: request.signal,
    start: (requestId: number): AiChatWorkerMessage => ({ type: "synthesizeVoice", requestId, text: request.text, tone: request.tone }),
    cancel: (requestId: number): AiChatWorkerMessage => ({ type: "cancelVoiceSynthesis", requestId }),
  });
}
