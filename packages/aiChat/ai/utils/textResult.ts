/**
 * 文本生成结果的失败归因与正文收尾判定。
 */

import type { AiTextResult } from "../../../types/aiChat/provider";

/** 各实现包共用的请求失败归因档位。 */
export type AiRequestFailureKind =
  | "request"
  | "rejected"
  | "response"
  | "refused"
  | "unsupported"
  | "misconfigured";

/**
 * 将单次请求失败映射为 AiTextResult：
 * response 允许重采样；refused 标记拒答且不重采样；媒体能力下将 unsupported、misconfigured 与瞬时端点故障映射为对应的 mediaFailure。
 */
export function classifyAiTextFailure(
  failureKind: AiRequestFailureKind,
  capability: "summary" | "media" | "text"
): AiTextResult {
  if (failureKind === "response") return { ok: false, retryable: true };
  if (failureKind === "refused") return { ok: false, retryable: false, refused: true };
  if (capability !== "media" || failureKind === "rejected") return { ok: false, retryable: false };
  if (failureKind === "unsupported") return { ok: false, retryable: false, mediaFailure: "unsupported" };
  if (failureKind === "misconfigured") return { ok: false, retryable: false, mediaFailure: "misconfigured" };
  return { ok: false, retryable: false, mediaFailure: "transient" };
}

/**
 * 将清洗后的文本收敛为 AiTextResult：非空为成功，空串视为可重采样失败。
 */
export function finalizeAiTextResult(normalizedText: string): AiTextResult {
  return normalizedText.length > 0
    ? { ok: true, text: normalizedText }
    : { ok: false, retryable: true };
}
