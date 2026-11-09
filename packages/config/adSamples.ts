import { defaultAdSampleConfigCache } from "../cache/perThread/config";
import {
  AD_SAMPLE_CONFIG_KEYS,
  AD_SAMPLE_MAX_CHARS,
  MAX_CONFIGURED_AD_BLACKLIST_PACKS,
  MAX_CONFIGURED_AD_SAMPLES,
} from "../consts/antiRaid/adDetect";
import { AD_SAMPLES_CONFIG_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../libs/record";
import { sanitizeInline } from "../libs/text";
import type { AdSampleConfig } from "../types/config";
import { parseStickerPackNames } from "./stickerPackNames";

/**
 * 严格解码 ad_data.json：顶层必须精确包含 `samples`、`sticker_black_list` 与 `emoji_black_list`
 * 三个字符串数组，拒绝空串、超长、非法包名与重复。
 * @param value 待校验的原始 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 规范化并去重后的广告示例与黑名单配置。
 */
export function parseAdSampleConfig(
  value: unknown,
  sourcePath: string = AD_SAMPLES_CONFIG_PATH
): AdSampleConfig {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, AD_SAMPLE_CONFIG_KEYS) ||
    !Array.isArray(value.samples) ||
    !Array.isArray(value.sticker_black_list) ||
    !Array.isArray(value.emoji_black_list)
  ) {
    return invalidInput(
      sourcePath,
      "$",
      "exactly { samples: string[], sticker_black_list: string[], emoji_black_list: string[] }"
    );
  }
  if (value.samples.length > MAX_CONFIGURED_AD_SAMPLES) {
    return invalidInput(
      sourcePath,
      "$.samples",
      `an array with at most ${MAX_CONFIGURED_AD_SAMPLES} entries`
    );
  }

  const samples: string[] = [];
  const seenSamples: Set<string> = new Set();
  for (let index: number = 0; index < value.samples.length; index++) {
    const sample: unknown = value.samples[index];
    if (typeof sample !== "string") {
      return invalidInput(sourcePath, `$.samples[${index}]`, "a non-empty string");
    }
    // 空白序列压成单个空格并去掉首尾空白后，再判空、判长与判重；示例按单行拼进提示词。
    const normalized: string = sanitizeInline(sample);
    if (normalized.length === 0) {
      return invalidInput(sourcePath, `$.samples[${index}]`, "a non-empty string");
    }
    if (normalized.length > AD_SAMPLE_MAX_CHARS) {
      return invalidInput(
        sourcePath,
        `$.samples[${index}]`,
        `a string no longer than ${AD_SAMPLE_MAX_CHARS} characters`
      );
    }
    if (seenSamples.has(normalized)) {
      return invalidInput(
        sourcePath,
        `$.samples[${index}]`,
        "unique after whitespace normalization"
      );
    }
    seenSamples.add(normalized);
    samples.push(normalized);
  }

  return {
    samples,
    stickerBlackList: parseStickerPackNames({
      entries: value.sticker_black_list,
      sourcePath,
      fieldPath: "$.sticker_black_list",
      maxEntries: MAX_CONFIGURED_AD_BLACKLIST_PACKS,
    }),
    emojiBlackList: parseStickerPackNames({
      entries: value.emoji_black_list,
      sourcePath,
      fieldPath: "$.emoji_black_list",
      maxEntries: MAX_CONFIGURED_AD_BLACKLIST_PACKS,
    }),
  };
}

/**
 * 从 AD_SAMPLES_CONFIG_PATH 加载并校验；模块 import 本身不访问文件系统。
 * @returns 已通过校验的广告示例与黑名单配置。
 */
export async function loadAdSampleConfig(): Promise<AdSampleConfig> {
  return parseAdSampleConfig(await readJsonInput(AD_SAMPLES_CONFIG_PATH), AD_SAMPLES_CONFIG_PATH);
}

/**
 * 接管已经严格校验的广告示例与黑名单快照：启动预检、Worker 初始化消息或 config/dynamic/ 热重载。
 * null 只来自主线程热重载，表示部署方删除了该文件。
 * @param config 已校验的广告示例与黑名单配置，或表示文件已移除的 null。
 */
export function adoptAdSampleConfig(config: AdSampleConfig | null): void {
  defaultAdSampleConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureAdSampleConfig(): Promise<void> {
  if (defaultAdSampleConfigCache.current !== null) return;
  adoptAdSampleConfig(await loadAdSampleConfig());
}

/**
 * 默认广告示例与黑名单配置只读当前线程已校验的快照，不在运行期回退读盘。
 * @returns 当前线程已接管的广告示例与黑名单配置。
 */
export function getAdSampleConfig(): AdSampleConfig {
  const config: AdSampleConfig | null = defaultAdSampleConfigCache.current;
  if (config === null) {
    throw new Error(`Ad sample configuration was not initialized from ${AD_SAMPLES_CONFIG_PATH}.`);
  }
  return config;
}
