/**
 * 文本生成的退避重采样。
 */

import { logger } from "../../../infra/logger";
import { sleep } from "../../../libs/sleep";
import type { AiTextResult } from "../../../types/aiChat/provider";

/** resampleAiText 的入参。 */
export interface ResampleAiTextOptions {
  /** 日志中标识本次生成任务的英文前缀。 */
  readonly label: string;
  /** 发起单次文本采样。 */
  readonly call: () => Promise<AiTextResult>;
  /** 逐档重采样前的等待毫秒数列表；长度即重采样次数上限。 */
  readonly delaysMs: readonly number[];
  /** 当前任务的取消信号。 */
  readonly signal: AbortSignal;
}

/**
 * 执行文本采样，当结果标记为可重采样时按 delaysMs 逐档等待后重新采样；
 * 成功返回文本，不可重采样、档位用尽或采样前后 signal 已中止时返回 null。
 * @param options 文本采样函数、退避延迟列表与取消信号。
 * @returns 采样成功的文本；失败或取消时返回 null。
 */
export async function resampleAiText({ label, call, delaysMs, signal }: ResampleAiTextOptions): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    if (signal.aborted) return null;
    const result: AiTextResult = await call();
    if (signal.aborted) return null;
    if (result.ok) return result.text;
    if (!result.retryable || attempt >= delaysMs.length) return null;
    const delayMs: number = delaysMs[attempt]!;
    logger.warn(`${label} attempt ${attempt + 1} returned no usable text; resampling in ${delayMs} ms.`);
    await sleep(delayMs, signal);
  }
}
