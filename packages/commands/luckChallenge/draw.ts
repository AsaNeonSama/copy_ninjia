import { LUCK_TIERS } from "../../consts/luckChallenge";
import { deriveLuckEntropy } from "../../libs/luckReceipt";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";

/**
 * 按 LUCK_TIERS 的累计权重为抽签值选择档位。
 * @param roll 落在 `[0, 100)` 区间的抽签权重点数。
 * @returns 命中的运势档位定义。
 */
export function drawLuckTier(roll: number): LuckTier {
  let cumulative: number = 0;
  for (const tier of LUCK_TIERS) {
    cumulative += tier.weight;
    if (roll < cumulative) return tier;
  }
  return LUCK_TIERS[LUCK_TIERS.length - 1]!;
}

/**
 * 在档位的好运百分比区间内按归一化比例插值，并保留两位小数。
 * @param range 档位的好运百分比闭区间 `[min, max]`。
 * @param fraction 落在 `[0, 1)` 区间的插值比例。
 * @returns 保留两位小数的好运百分比。
 */
function rollFortunePercent([min, max]: readonly [number, number], fraction: number): number {
  const raw: number = min + fraction * (max - min);
  return Math.round(raw * 100) / 100;
}

/**
 * 从摘要读取无符号大端 32 位整数，不建立 DataView 或 Buffer 视图。
 * @param bytes 摘要字节数组。
 * @param offset 读取起始偏移下标。
 * @returns 无符号 32 位整数。
 */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1_000000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!;
}

/**
 * 当日密钥 + cache key 的确定性抽签；pending 淘汰或进程重启后仍得到同一结果。
 * @param secret 当日运势回执密钥。
 * @param cacheKey 当日运势缓存键。
 * @returns 确定性派生出的运势档位与好运百分比。
 */
export function deriveLuckDraw(secret: LuckReceiptSecret, cacheKey: string): LuckDraw {
  const entropy: Uint8Array = deriveLuckEntropy(secret, cacheKey);
  const tierRoll: number = readUint32BE(entropy, 0) / 0x1_0000_0000 * 100;
  const tier: LuckTier = drawLuckTier(tierRoll);
  const fraction: number = readUint32BE(entropy, 4) / 0x1_0000_0000;
  return { tier, fortunePercent: rollFortunePercent(tier.fortunePercentRange, fraction) };
}
