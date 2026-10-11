/**
 * 文本生成的退避重采样，贴纸目录（逐枚视觉解析、整包简介）与镜像压缩共用。
 */

import { logger } from "../../../infra/logger";
import { sleep } from "../../../libs/sleep";
import type { AiTextResult } from "../../../types/aiChat/provider";

/** resampleAiText 的入参。 */
export interface ResampleAiTextOptions {
  /** 日志里描述这次生成的英文前缀，如 `AI compaction for chat -100`。 */
  readonly label: string;
  /** 发起一次采样。 */
  readonly call: () => Promise<AiTextResult>;
  /** 逐档重采样前的等待（ms）；档位数即重采样次数上限。 */
  readonly delaysMs: readonly number[];
  readonly signal: AbortSignal;
}

/**
 * 跑一次文本生成；结果的 retryable 为 true 时按 delaysMs 逐档重新采样，每次重采样前记一条 warn。
 * 哪些失败可重采样由调用方给出的结果决定（口径见 aiChat/ai/utils/textResult.ts）。
 * @returns 成功时的正文；档位用尽、retryable 为 false，或采样前后 signal 已中止时返回 null。
 *   退避等待期间中止时，按 libs/sleep.ts 的 sleep 以中止原因 reject，由调用方的 catch 按 signal 收尾。
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
