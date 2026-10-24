/**
 * 累加非负安全整数并在 Number.MAX_SAFE_INTEGER 饱和。
 * @param left 第一个非负安全整数加数。
 * @param right 第二个非负安全整数加数。
 * @returns 封顶在 `Number.MAX_SAFE_INTEGER` 内的非负安全整数和。
 */
export function saturatingSafeIntegerAdd(left: number, right: number): number {
  if (right >= Number.MAX_SAFE_INTEGER - left) return Number.MAX_SAFE_INTEGER;
  return left + right;
}
