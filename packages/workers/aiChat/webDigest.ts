/**
 * cron `send_web_digest` 转交的摘要组稿在 AI Worker 侧的执行：调用 composeWebDigest 检索并组稿，
 * 通过 `webDigestComposed` 回执返回结果。
 */

import { webDigestRequests } from "../../cache/workers/aiChat/webDigest";
import { composeWebDigest } from "../../aiChat/ai/webDigest";
import { agentDeploymentConfigSnapshot } from "../../config/agent";
import { logger } from "../../infra/logger";
import type {
  AiCancelWebDigestMessage,
  AiComposeWebDigestMessage,
  AiWebDigestComposedEvent,
} from "../../types/aiChat/protocol";
import type { WebDigestCompositionResult } from "../../types/webDigest";
import { runAiWorkerJob } from "./workerJob";

declare const self: Worker;

/**
 * 组稿一次；对话能力缺席时直接返回失败原因，意外异常按组稿失败结算。
 *
 * @param msg 主线程下发的摘要组稿请求消息
 * @param signal 合并了单请求取消与 Worker 停机信号的 AbortSignal
 * @returns 联网摘要组稿结果（成功时含 HTML 正文，失败时含失败原因）
 */
async function compose(msg: AiComposeWebDigestMessage, signal: AbortSignal): Promise<WebDigestCompositionResult> {
  if (agentDeploymentConfigSnapshot() === null) return { ok: false, reason: "ai unconfigured" };
  try {
    return await composeWebDigest(msg.request, signal);
  } catch (error: unknown) {
    logger.error(`Web digest composition for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "compose failed" };
  }
}

/**
 * 接纳一次组稿请求；结算后回执。
 *
 * @param msg 主线程下发的摘要组稿请求消息
 */
export function handleComposeWebDigest(msg: AiComposeWebDigestMessage): void {
  runAiWorkerJob<WebDigestCompositionResult>({
    jobs: webDigestRequests,
    requestId: msg.requestId,
    run: (signal: AbortSignal): Promise<WebDigestCompositionResult> => compose(msg, signal),
    publish: (result: WebDigestCompositionResult): void => {
      self.postMessage({ type: "webDigestComposed", requestId: msg.requestId, result } satisfies AiWebDigestComposedEvent);
    },
  });
}

/**
 * 撤回一次在途组稿；已结算或未知的 requestId 不做任何事。
 *
 * @param msg 主线程下发的取消摘要组稿消息
 */
export function handleCancelWebDigest(msg: AiCancelWebDigestMessage): void {
  webDigestRequests.get(msg.requestId)?.abort();
}
