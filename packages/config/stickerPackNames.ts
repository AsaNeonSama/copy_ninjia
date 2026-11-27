import { STICKER_PACK_NAME_PATTERN } from "../consts/aiChat/stickers";
import { invalidInput } from "../libs/inputValidation";

/** parseStickerPackNames 的输入。 */
export interface ParseStickerPackNamesOptions {
  /** 部署 JSON 里该字段的原始数组。 */
  readonly entries: readonly unknown[];
  /** 配置文件路径，用于构造致命错误诊断。 */
  readonly sourcePath: string;
  /** 该数组字段的 JSONPath（如 `$.packs`）。 */
  readonly fieldPath: string;
  /** 可选的允许最大条数；省略时不设条数硬上限。 */
  readonly maxEntries?: number;
}

/**
 * 严格解码贴纸包或自定义表情包 short name 数组（如 `stickers.json` 的 `packs`）：
 * 去掉首尾空白后按 STICKER_PACK_NAME_PATTERN 校验，拒绝非法、重复及超过可选上限的数组。
 * @param options 原始数组、诊断用路径与可选条数上限。
 * @returns 规范化后的 short name 列表。
 */
export function parseStickerPackNames(
  { entries, sourcePath, fieldPath, maxEntries }: ParseStickerPackNamesOptions
): readonly string[] {
  if (maxEntries !== undefined && entries.length > maxEntries) {
    return invalidInput(sourcePath, fieldPath, `an array with at most ${maxEntries} entries`);
  }
  const packs: string[] = [];
  const seen: Set<string> = new Set();
  for (let index: number = 0; index < entries.length; index++) {
    const entry: unknown = entries[index];
    const pack: string = typeof entry === "string" ? entry.trim() : "";
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(sourcePath, `${fieldPath}[${index}]`, "a valid Telegram sticker pack short name");
    }
    if (seen.has(pack)) return invalidInput(sourcePath, `${fieldPath}[${index}]`, "unique");
    seen.add(pack);
    packs.push(pack);
  }
  return packs;
}
