/**
 * 广告检测结构化 JSON 请求在成功返回但正文不可用（空正文、截断或异常收尾）时的
 * 统一有界重采样循环（Anti-Raid Worker 侧）。请求级异常已由各 provider SDK 重试过，不在此叠加。
 */

import { AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS } from "../../../../consts/antiRaid/adDetect/limits";
import type { AdDetectProviderResult } from "../../../../types/antiRaid/adDetect";

/** 广告检测空正文有界重试循环的调用参数。 */
export interface AdDetectEmptyBodyRetryOptions<Attempt> {
  /** 执行一次底层请求并返回收窄后的尝试结果；遇明确不支持视觉输入时返回 `"visionUnsupported"`，其余请求异常返回 null 或 undefined。 */
  readonly attemptRequest: () => Promise<Attempt | "visionUnsupported" | null | undefined>;
  /** 从单次尝试结果中提取可用 JSON 正文；响应不可用或正文为空时返回 null。 */
  readonly extractUsableBody: (attempt: Attempt) => string | null;
  /** 判断不可用响应是否允许继续重采样；缺省表示在尝试次数上限内始终重采样。 */
  readonly canRetry?: (attempt: Attempt) => boolean;
  /** 准备发起下一轮重采样前确认是否仍可继续（如未进入停机阶段）；返回 `false` 时静默放弃，不记耗尽日志。 */
  readonly shouldContinue?: () => boolean;
  /** 无法重采样或重试次数耗尽时记录包含最后一次尝试诊断信息的错误日志。 */
  readonly logExhausted: (attempt: Attempt, attempts: number) => void;
}

/**
 * 执行带 `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` 上限的广告检测请求与不可用正文重采样。
 * @param options 单次尝试、正文可用性判定、可重试判定、继续判定与耗尽日志回调。
 * @returns 传输层统一结果（可用正文、明确不支持视觉输入或失败）。
 */
export async function requestAdDetectJsonWithRetry<Attempt>({
  attemptRequest,
  extractUsableBody,
  canRetry,
  shouldContinue,
  logExhausted,
}: AdDetectEmptyBodyRetryOptions<Attempt>): Promise<AdDetectProviderResult> {
  for (let attempt: number = 1; ; attempt++) {
    const result: Attempt | "visionUnsupported" | null | undefined = await attemptRequest();
    if (result === "visionUnsupported") return { status: "visionUnsupported" };
    if (result === null || result === undefined) return { status: "failed" };
    const body: string | null = extractUsableBody(result);
    if (body !== null) return { status: "ok", body };
    const retryAllowed: boolean = canRetry === undefined || canRetry(result);
    if (retryAllowed && attempt < AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS) {
      if (shouldContinue !== undefined && !shouldContinue()) return { status: "failed" };
      continue;
    }
    logExhausted(result, attempt);
    return { status: "failed" };
  }
}
