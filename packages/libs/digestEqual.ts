/**
 * 以常量时间比对两个字符串的 UTF-8 SHA-256 摘要。
 * @param left 待比对的左侧字符串。
 * @param right 待比对的右侧字符串。
 * @returns 两侧字符串的 UTF-8 SHA-256 摘要完全一致时返回 `true`，否则返回 `false`。
 */
export function timingSafeStringEqual(left: string, right: string): boolean {
  return crypto.timingSafeEqual(Bun.SHA256.hash(left), Bun.SHA256.hash(right));
}
