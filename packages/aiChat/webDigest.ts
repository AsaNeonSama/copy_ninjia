/**
 * 主线程向 AI Worker 发起联网摘要组稿请求的客户端入口。
 */

import { agentDeploymentConfigSnapshot } from "../config/agent";
import { WEB_DIGEST_REQUEST_TIMEOUT_MS } from "../consts/webDigest";
import { webDigestRequests } from "../cache/main/aiChat";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { AiWorkerJobTransport } from "../types/aiChat/workerJob";
import type { WebDigestCompositionResult, WebDigestRequest } from "../types/webDigest";
import { requestAiWorkerJob } from "./workerJob";

/**
 * 请求 AI Worker 生成联网摘要；未配置 agent 或 Worker 不可用时直接返回对应失败原因。
 * @param request 联网摘要检索与组稿参数。
 * @param signal 调用方取消信号。
 * @param transport 向 AI Worker 投递消息的传输通道与可用性状态。
 * @returns 联网摘要组稿结果或失败原因。
 */
export function requestWebDigest(
  request: WebDigestRequest,
  signal: AbortSignal,
  transport: AiWorkerJobTransport
): Promise<WebDigestCompositionResult> {
  if (agentDeploymentConfigSnapshot() === null) return Promise.resolve({ ok: false, reason: "ai unconfigured" });
  return requestAiWorkerJob<WebDigestCompositionResult>({
    table: webDigestRequests,
    timeoutMs: WEB_DIGEST_REQUEST_TIMEOUT_MS,
    transport,
    signal,
    start: (requestId: number): AiChatWorkerMessage => ({ type: "composeWebDigest", requestId, request }),
    cancel: (requestId: number): AiChatWorkerMessage => ({ type: "cancelWebDigest", requestId }),
  });
}
