import { defaultAdDetectConfigCache } from "../cache/perThread/config";
import {
  AD_BLOCK_SCOPES,
  AD_DETECT_CONFIG_KEYS,
  AD_PUNISHMENT_KEYS,
  AD_PUNISHMENT_KICK_KEYS,
  AD_PUNISHMENT_MUTE_KEYS,
  AD_SAMPLE_MAX_CHARS,
  MAX_CONFIGURED_AD_BLACKLIST_PACKS,
  MAX_CONFIGURED_AD_SAMPLES,
} from "../consts/antiRaid/adDetect";
import {
  DURATION_UNIT_MS,
  MUTE_MAX_DURATION_MS,
  MUTE_MIN_DURATION_MS,
} from "../consts/commands";
import { AD_DETECT_CONFIG_PATH } from "../consts/paths";
import { parseDurationTokenMs } from "../libs/durationToken";
import { invalidInput } from "../libs/inputValidation";
import { ensureConfigSnapshot, loadJsonConfig } from "./snapshotHolder";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../libs/record";
import { sanitizeInline } from "../libs/text";
import type {
  AdBlockScope,
  AdDetectConfig,
  AdDetectPunishment,
} from "../types/config";
import { parseStickerPackNames } from "./stickerPackNames";

/**
 * 严格解码 `punishment.mute`：`permanent` 为 true 时不得带 `duration`；为 false 时 `duration` 必须是
 * `数字+m/h/d` 时长（去掉首尾空白），落在 [MUTE_MIN_DURATION_MS, MUTE_MAX_DURATION_MS] 内，越界即拒绝。
 * @param value `punishment.mute` 的原始值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 禁言时长毫秒数；永久禁言返回 null。
 */
function parseMutePunishment(value: unknown, sourcePath: string): number | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, AD_PUNISHMENT_MUTE_KEYS)) {
    return invalidInput(
      sourcePath,
      "$.punishment.mute",
      "an object { permanent: boolean, duration?: string }"
    );
  }
  if (typeof value.permanent !== "boolean") {
    return invalidInput(sourcePath, "$.punishment.mute.permanent", "a boolean");
  }
  if (value.permanent) {
    if (value.duration !== undefined) {
      return invalidInput(sourcePath, "$.punishment.mute.duration", "absent when permanent is true");
    }
    return null;
  }
  const durationMs: number | undefined = typeof value.duration === "string"
    ? parseDurationTokenMs(value.duration.trim())
    : undefined;
  if (
    durationMs === undefined ||
    durationMs < MUTE_MIN_DURATION_MS ||
    durationMs > MUTE_MAX_DURATION_MS
  ) {
    return invalidInput(
      sourcePath,
      "$.punishment.mute.duration",
      `a duration such as "30m", "12h" or "7d" between ${MUTE_MIN_DURATION_MS / DURATION_UNIT_MS.m}m ` +
      `and ${MUTE_MAX_DURATION_MS / DURATION_UNIT_MS.d}d when permanent is false`
    );
  }
  return durationMs;
}

/**
 * 严格解码 `punishment.kick`：`block` 为 false 时不得带 `block_scope`；为 true 时 `block_scope`
 * 必须是 AD_BLOCK_SCOPES 之一（去掉首尾空白）。
 * @param value `punishment.kick` 的原始值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 封禁范围；只踢不封返回 null。
 */
function parseKickPunishment(value: unknown, sourcePath: string): AdBlockScope | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, AD_PUNISHMENT_KICK_KEYS)) {
    return invalidInput(
      sourcePath,
      "$.punishment.kick",
      "an object { block: boolean, block_scope?: \"chat\" | \"global\" }"
    );
  }
  if (typeof value.block !== "boolean") {
    return invalidInput(sourcePath, "$.punishment.kick.block", "a boolean");
  }
  if (!value.block) {
    if (value.block_scope !== undefined) {
      return invalidInput(sourcePath, "$.punishment.kick.block_scope", "absent when block is false");
    }
    return null;
  }
  const scopeText: string = typeof value.block_scope === "string" ? value.block_scope.trim() : "";
  const scope: AdBlockScope | undefined = AD_BLOCK_SCOPES.find(
    (candidate: AdBlockScope): boolean => candidate === scopeText
  );
  if (scope === undefined) {
    return invalidInput(
      sourcePath,
      "$.punishment.kick.block_scope",
      "\"chat\" or \"global\" when block is true"
    );
  }
  return scope;
}

/**
 * 严格解码 `punishment`：只允许 `mute`、`kick` 两个键，且二者互斥、必须恰好出现其一。
 * @param value `punishment` 的原始值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 禁言或移出处罚设置。
 */
function parsePunishment(value: unknown, sourcePath: string): AdDetectPunishment {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, AD_PUNISHMENT_KEYS) ||
    (value.mute === undefined) === (value.kick === undefined)
  ) {
    return invalidInput(sourcePath, "$.punishment", "an object with exactly one of mute or kick");
  }
  if (value.mute !== undefined) {
    return { kind: "mute", durationMs: parseMutePunishment(value.mute, sourcePath) };
  }
  return { kind: "kick", blockScope: parseKickPunishment(value.kick, sourcePath) };
}

/**
 * 严格解码 ad_detect.json：顶层必须精确包含对象 `punishment` 与 `samples`、`sticker_black_list`、
 * `emoji_black_list` 三个字符串数组；拒绝非法处罚设置、空串、超长、非法包名与重复。
 * @param value 待校验的原始 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 处罚设置与规范化并去重后的广告示例、黑名单配置。
 */
export function parseAdDetectConfig(
  value: unknown,
  sourcePath: string = AD_DETECT_CONFIG_PATH
): AdDetectConfig {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, AD_DETECT_CONFIG_KEYS) ||
    !Array.isArray(value.samples) ||
    !Array.isArray(value.sticker_black_list) ||
    !Array.isArray(value.emoji_black_list)
  ) {
    return invalidInput(
      sourcePath,
      "$",
      "exactly { punishment: object, samples: string[], sticker_black_list: string[], emoji_black_list: string[] }"
    );
  }
  const punishment: AdDetectPunishment = parsePunishment(value.punishment, sourcePath);
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
    punishment,
    samples,
    stickerBlackList: new Set(parseStickerPackNames({
      entries: value.sticker_black_list,
      sourcePath,
      fieldPath: "$.sticker_black_list",
      maxEntries: MAX_CONFIGURED_AD_BLACKLIST_PACKS,
    })),
    emojiBlackList: new Set(parseStickerPackNames({
      entries: value.emoji_black_list,
      sourcePath,
      fieldPath: "$.emoji_black_list",
      maxEntries: MAX_CONFIGURED_AD_BLACKLIST_PACKS,
    })),
  };
}

/**
 * 从 AD_DETECT_CONFIG_PATH 加载并校验；模块 import 本身不访问文件系统。
 * @returns 已通过校验的广告检测部署配置。
 */
export async function loadAdDetectConfig(): Promise<AdDetectConfig> {
  return loadJsonConfig(AD_DETECT_CONFIG_PATH, parseAdDetectConfig);
}

/**
 * 接管已经严格校验的广告检测部署配置快照：Worker 初始化消息或 config/dynamic/ 热重载。
 * null 只来自主线程热重载，表示部署方删除了该文件。
 * @param config 已校验的广告检测部署配置，或表示文件已移除的 null。
 */
export function adoptAdDetectConfig(config: AdDetectConfig | null): void {
  defaultAdDetectConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureAdDetectConfig(): Promise<void> {
  await ensureConfigSnapshot(defaultAdDetectConfigCache, loadAdDetectConfig);
}

/**
 * 只读当前线程已校验的广告检测部署配置快照，不在运行期回退读盘。
 * @returns 当前线程已接管的广告检测部署配置。
 */
export function getAdDetectConfig(): AdDetectConfig {
  const config: AdDetectConfig | null = defaultAdDetectConfigCache.current;
  if (config === null) {
    throw new Error(`Ad detection configuration was not initialized from ${AD_DETECT_CONFIG_PATH}.`);
  }
  return config;
}

/**
 * 主线程处置广告命中时读取当前处罚设置；部署方在热重载中删除了 ad_detect.json 时返回 null。
 * @returns 当前生效的处罚设置；配置已移除时返回 null。
 */
export function currentAdDetectPunishment(): AdDetectPunishment | null {
  return defaultAdDetectConfigCache.current?.punishment ?? null;
}
