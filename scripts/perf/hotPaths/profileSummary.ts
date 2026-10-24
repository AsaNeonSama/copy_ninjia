/** JSC 稳态栈采样与优化分层摘要；GC 暂停由 gcProfile 独立计量。 */
export interface HotPathSamplingProfileSummary {
  readonly totalSamples: number;
  readonly llintPercent: number;
  readonly baselinePercent: number;
  readonly dfgPercent: number;
  readonly ftlPercent: number;
}

export interface HotPathSamplingProfileText {
  readonly functions: string;
  readonly bytecodes: string;
}

/**
 * 从采样剖析文本中按正则提取必填非负数值。
 *
 * @param text 待匹配的采样剖析文本
 * @param pattern 含首个捕获组的匹配正则
 * @param label 用于错误提示的字段标签
 * @returns 解析出的非负有限数值
 */
function requiredNumber(text: string, pattern: RegExp, label: string): number {
  const value: string | undefined = pattern.exec(text)?.[1];
  if (value === undefined) {
    throw new Error(`JSC sampling profile omitted ${label}.`);
  }
  const parsed: number = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`JSC sampling profile returned an invalid ${label}.`);
  }
  return parsed;
}

/**
 * 从字节码采样汇总文本中提取指定优化分层的样本占比百分比。
 *
 * @param bytecodes 字节码分层汇总文本
 * @param tier 分层名称（如 LLInt、Baseline、DFG、FTL）
 * @returns 该分层的样本占比百分比
 */
function tierPercent(bytecodes: string, tier: string): number {
  return requiredNumber(
    bytecodes,
    new RegExp(`^${tier}:\\s+\\d+\\s+\\(([\\d.]+)%\\)`, "m"),
    `${tier} percentage`
  );
}

/**
 * 解析当前 Bun `bun:jsc.profile` 正式稳态循环中的采样总数与字节码分层字段。
 *
 * @param profile `bun:jsc.profile` 返回的函数与字节码汇总文本
 * @returns 提取出的采样总数与各分层占比摘要
 */
export function summarizeHotPathSamplingProfile(
  profile: HotPathSamplingProfileText
): HotPathSamplingProfileSummary {
  const totalSamples: number = requiredNumber(
    profile.functions,
    /Total samples:\s*(\d+)/,
    "total sample count"
  );
  return {
    totalSamples,
    llintPercent: tierPercent(profile.bytecodes, "LLInt"),
    baselinePercent: tierPercent(profile.bytecodes, "Baseline"),
    dfgPercent: tierPercent(profile.bytecodes, "DFG"),
    ftlPercent: tierPercent(profile.bytecodes, "FTL"),
  };
}
