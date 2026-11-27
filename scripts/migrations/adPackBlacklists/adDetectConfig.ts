/** `migrate:ad-pack-blacklists` 的旧版 4 键 `ad_detect.json` 严格解码与 2 键清理输出。 */
import { parseAdDetectConfig } from "../../../packages/config/adDetectConfig";
import { parseStickerPackNames } from "../../../packages/config/stickerPackNames";
import { invalidInput } from "../../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../../packages/libs/record";

/** 旧版 19.1.0 格式 `ad_detect.json` 顶层必须精确具备的四个键名。 */
const LEGACY_AD_DETECT_CONFIG_KEYS: readonly string[] = [
  "punishment",
  "samples",
  "sticker_black_list",
  "emoji_black_list",
];

/** 输出 2 键 `ad_detect.json` 使用的 JSON 缩进空格数。 */
const CLEANED_CONFIG_JSON_INDENT: number = 2;

/** 旧版 4 键 `ad_detect.json` 解码结果：提取出的双黑名单与清理后的 2 键 JSON 文本。 */
export interface LegacyAdDetectConfigMigrationData {
  /** 去除首尾空白并校验去重后的贴纸包黑名单列表。 */
  readonly stickerBlackList: readonly string[];
  /** 去除首尾空白并校验去重后的自定义表情包黑名单列表。 */
  readonly emojiBlackList: readonly string[];
  /** 移除双黑名单字段后的 2 键 `{ punishment, samples }` 格式化 JSON 文本（末尾含换行）。 */
  readonly cleanedJson: string;
}

/**
 * 严格解码旧版 4 键 `ad_detect.json`：
 * - 顶层必须精确包含 `punishment`、`samples`、`sticker_black_list` 与 `emoji_black_list`（拒绝已迁移的 2 键文件与未知字段）；
 * - `punishment` 与 `samples` 交给生产 `parseAdDetectConfig` 按当前口径完整校验；
 * - `sticker_black_list` 与 `emoji_black_list` 各自按 `STICKER_PACK_NAME_PATTERN` 与 trim 后唯一性校验（不设条数硬上限）。
 *
 * @param value `JSON.parse` 解析出的原始值。
 * @param sourcePath 源 `ad_detect.json` 路径，用于构造致命错误诊断。
 * @returns 校验提取后的双黑名单列表与待写出的 2 键 JSON 文本。
 */
export function parseLegacyAdDetectConfig(
  value: unknown,
  sourcePath: string
): LegacyAdDetectConfigMigrationData {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, LEGACY_AD_DETECT_CONFIG_KEYS) ||
    !Array.isArray(value.sticker_black_list) ||
    !Array.isArray(value.emoji_black_list)
  ) {
    return invalidInput(
      sourcePath,
      "$",
      "exactly { punishment: object, samples: string[], sticker_black_list: string[], emoji_black_list: string[] }"
    );
  }
  const cleanedPayload: Readonly<Record<string, unknown>> = {
    punishment: value.punishment,
    samples: value.samples,
  };
  parseAdDetectConfig(cleanedPayload, sourcePath);
  const stickerBlackList: readonly string[] = parseStickerPackNames({
    entries: value.sticker_black_list,
    sourcePath,
    fieldPath: "$.sticker_black_list",
  });
  const emojiBlackList: readonly string[] = parseStickerPackNames({
    entries: value.emoji_black_list,
    sourcePath,
    fieldPath: "$.emoji_black_list",
  });
  return {
    stickerBlackList,
    emojiBlackList,
    cleanedJson: `${JSON.stringify(cleanedPayload, null, CLEANED_CONFIG_JSON_INDENT)}\n`,
  };
}
