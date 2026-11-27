/**
 * 贴纸包与自定义表情包 short name 的保序去重与格式筛选纯函数。
 */
import { STICKER_PACK_NAME_PATTERN } from "../consts/aiChat/stickers";

/** `collectValidStickerPackNames` 的筛选选项。 */
export interface CollectValidStickerPackNamesOptions {
  /** 为 `true` 时先对原始包名执行 `trim()` 再校验格式。 */
  readonly trim?: boolean;
  /** 可选的允许集合；传入时仅保留落在该集合内的包名。 */
  readonly allowed?: ReadonlySet<string>;
}

/**
 * 按首次出现顺序对字符串列表去重。
 *
 * @param items 原始字符串列表。
 * @returns 保序去重后的新数组。
 */
export function deduplicatePreservingOrder(items: readonly string[]): string[] {
  const seen: Set<string> = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * 按 `STICKER_PACK_NAME_PATTERN` 筛选合法包名并按首次出现顺序去重，可选首尾裁剪与白名单求交集。
 *
 * @param packs 原始包名列表。
 * @param options 裁剪与候选白名单选项。
 * @returns 合法且去重后的包名数组。
 */
export function collectValidStickerPackNames(
  packs: readonly string[],
  options?: Readonly<CollectValidStickerPackNamesOptions>
): string[] {
  const trim: boolean = options?.trim === true;
  const allowed: ReadonlySet<string> | undefined = options?.allowed;
  const seen: Set<string> = new Set<string>();
  const result: string[] = [];
  for (const raw of packs) {
    const pack: string = trim ? raw.trim() : raw;
    if (allowed !== undefined && !allowed.has(pack)) continue;
    if (!STICKER_PACK_NAME_PATTERN.test(pack) || seen.has(pack)) continue;
    seen.add(pack);
    result.push(pack);
  }
  return result;
}
