/**
 * 各性能基准共用的统计原语：中位数、平均值、总体标准差与最近秩分位数。
 */

/**
 * 算术平均值；调用方保证输入非空。
 * @param values 非空样本数值列表。
 * @returns 样本的算术平均值。
 */
export function mean(values: readonly number[]): number {
  let sum: number = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * 总体标准差（除以 n）；`average` 由调用方传入。
 * @param values 非空样本数值列表。
 * @param average 已算出的样本算术平均值。
 * @returns 样本的总体标准差。
 */
export function standardDeviation(
  values: readonly number[],
  average: number
): number {
  let squaredDifferenceSum: number = 0;
  for (const value of values) {
    const difference: number = value - average;
    squaredDifferenceSum += difference * difference;
  }
  return Math.sqrt(squaredDifferenceSum / values.length);
}

/**
 * 中位数；偶数个样本取偏大的那一个，不做插值。
 *
 * 输入为空时返回 NaN。
 * @param values 样本数值列表。
 * @returns 排序后的中位样本值；输入为空时返回 `NaN`。
 */
export function median(values: readonly number[]): number {
  const sorted: number[] = [...values].sort(
    (left: number, right: number): number => left - right
  );
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * 已升序样本的分位数，取「最近秩」，不做插值。
 * @param sortedAscending 已按升序排列的非空样本列表。
 * @param percentileRank 百分位秩（0 到 100）。
 * @returns 对应百分位秩的样本值。
 */
export function percentile(
  sortedAscending: readonly number[],
  percentileRank: number
): number {
  if (sortedAscending.length === 0) {
    throw new Error("Latency percentile requires at least one sample.");
  }
  const rank: number = Math.ceil(percentileRank / 100 * sortedAscending.length);
  const index: number = Math.min(
    sortedAscending.length - 1,
    Math.max(0, rank - 1)
  );
  return sortedAscending[index]!;
}
