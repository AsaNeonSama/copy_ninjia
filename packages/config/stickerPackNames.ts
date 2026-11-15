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
  /** 允许的最大条数。 */
  readonly maxEntries: number;
}

/**
 * 严格解码贴纸包或自定义表情包 short name 数组（stickers.json 的 packs，ad_detect.json 的
 * sticker_black_list 与 emoji_black_list）：去掉首尾空白后按 STICKER_PACK_NAME_PATTERN 校验，
 * 拒绝超量、非法与重复。
 * @param options 原始数组、诊断用路径与条数上限。
 * @returns 规范化后的 short name 列表。
 */
export function parseStickerPackNames(
  { entries, sourcePath, fieldPath, maxEntries }: ParseStickerPackNamesOptions
): readonly string[] {
  if (entries.length > maxEntries) {
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
