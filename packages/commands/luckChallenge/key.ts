/**
 * 默认运势按用户 ID；带所求事项时追加定长 SHA-256 摘要，键长度与原文长度无关。
 * @param userId 查询运势的用户 ID。
 * @param text 用户输入的所求事项文本；纯运势查询时为 undefined。
 * @returns 运势日缓存键。
 */
export function luckCacheKey(userId: number, text: string | undefined): string {
  if (!text) return String(userId);
  return `${userId}:${Bun.SHA256.hash(text, "hex")}`;
}
