/**
 * 稳定前缀指纹：把逐字不变的若干段提示词压成一个固定长度的摘要串。
 *
 * 调用方：OpenAI 回复会话的 `prompt_cache_key` 后缀（aiChat/openai/replySession.ts），
 * 以及 Gemini 共用显式缓存的分槽与内容键（infra/geminiContextCache.ts）。摘要算法为 SHA-256。
 *
 * 叶子模块：不 import 任何缓存；单槽版本的 holder 由调用方传入。
 */

import type { PrefixHasherSlot, PrefixHasherSlotHolder } from "../types/prefixFingerprint";

/**
 * 按顺序把各段拼进摘要。
 *
 * 段与段之间插入 NUL 分隔；被哈希的提示词与 JSON 文本不含 NUL，拼接边界没有歧义。
 * @param parts 已序列化好的前缀各段，顺序即语义，由调用方保证同一形态顺序稳定。
 * @returns base64url 摘要串，长度固定。
 */
export function stablePrefixFingerprint(parts: readonly string[]): string {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for (const part of parts) {
    hasher.update("\0");
    hasher.update(part);
  }
  return hasher.digest("base64url");
}

/** 两组前缀段逐段相等；同一字符串对象时 `===` 直接按引用判定。 */
function samePrefixParts(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index: number = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 与 `stablePrefixFingerprint([...head, ...tail])` 逐字节相同的摘要，head 部分按内容等值单槽复用。
 *
 * holder 里存着上一次 head 各段的原文与喂完这些段的哈希状态；本次 head 逐段相等时只 copy
 * 该状态再喂 tail，否则重建并替换整槽。槽里的 hasher 只被 copy，不被追加，并发调用互不影响。
 * @param holder 调用方线程独占的单槽（见 cache/workers/aiChat/replyPrefix.ts）。
 * @param head 跨调用通常不变的前几段（系统提示词、工具声明 JSON）。
 * @param tail 每次都重新喂入的后几段（按群变化的参考记忆等）。
 */
export function stablePrefixFingerprintWithSlot(
  holder: PrefixHasherSlotHolder,
  head: readonly string[],
  tail: readonly string[]
): string {
  let slot: PrefixHasherSlot | null = holder.current;
  if (slot === null || !samePrefixParts(slot.head, head)) {
    const prefixHasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
    for (const part of head) {
      prefixHasher.update("\0");
      prefixHasher.update(part);
    }
    slot = { head, hasher: prefixHasher };
    holder.current = slot;
  }
  const hasher: Bun.CryptoHasher = slot.hasher.copy();
  for (const part of tail) {
    hasher.update("\0");
    hasher.update(part);
  }
  return hasher.digest("base64url");
}
