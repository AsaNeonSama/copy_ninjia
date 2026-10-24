/**
 * 第 attempt 次重试（0 起算）的指数退避时长：baseMs × 2^attempt，封顶 maxMs。
 * 次数很大时乘积溢出为 Infinity，同样落在封顶值上。
 * @param baseMs 首次重试（attempt = 0）的基础退避毫秒数。
 * @param attempt 重试次数序号（从 0 起算）。
 * @param maxMs 退避时长的最大封顶毫秒数。
 * @returns 封顶后的退避等待毫秒数。
 */
export function cappedExponentialMs(baseMs: number, attempt: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}
