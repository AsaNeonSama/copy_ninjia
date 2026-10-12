/**
 * 已按顺序喂入若干前缀段的 SHA-256 状态，与这些段的原文一起保存；读写见
 * libs/prefixFingerprint.ts 的 stablePrefixFingerprintWithSlot。hasher 建好后只被 copy，不再追加。
 */
export interface PrefixHasherSlot {
  readonly head: readonly string[];
  readonly hasher: Bun.CryptoHasher;
}

/** 调用方线程独占的单槽 holder（如 cache/workers/aiChat/replyPrefix.ts 的 openAiReplyPrefixSlot）。 */
export interface PrefixHasherSlotHolder {
  current: PrefixHasherSlot | null;
}
