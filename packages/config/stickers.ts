import { defaultStickerConfigCache } from "../cache/perThread/config";
import { MAX_CONFIGURED_STICKER_PACKS } from "../consts/aiChat/stickers";
import { STICKERS_CONFIG_PATH } from "../consts/paths";
import { hasExactKeys, isPlainRecord } from "../libs/record";
import { invalidInput } from "../libs/inputValidation";
import { ensureConfigSnapshot, loadJsonConfig } from "./snapshotHolder";
import { parseStickerPackNames } from "./stickerPackNames";
import type { StickerConfig } from "../types/config";

/**
 * 严格解码 stickers.json（short name 去掉首尾空白），并拒绝超量、非法或重复的贴纸包 short name。
 * @param value 待校验的原始 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的贴纸包配置。
 */
export function parseStickerConfig(
  value: unknown,
  sourcePath: string = STICKERS_CONFIG_PATH
): StickerConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["packs"]) || !Array.isArray(value.packs)) {
    return invalidInput(sourcePath, "$", "exactly { packs: string[] }");
  }
  return {
    packs: parseStickerPackNames({
      entries: value.packs,
      sourcePath,
      fieldPath: "$.packs",
      maxEntries: MAX_CONFIGURED_STICKER_PACKS,
    }),
  };
}

/**
 * 从 STICKERS_CONFIG_PATH 加载并校验；模块 import 本身不访问文件系统。
 * @returns 已通过校验的贴纸包配置。
 */
export async function loadStickerConfig(): Promise<StickerConfig> {
  return loadJsonConfig(STICKERS_CONFIG_PATH, parseStickerConfig);
}

/**
 * 接管已经严格校验的贴纸配置快照：Worker 初始化消息或 config/dynamic/ 热重载。
 * null 只来自主线程热重载，表示部署方删除了该文件。
 * @param config 已校验的贴纸包配置，或表示文件已移除的 null。
 */
export function adoptStickerConfig(config: StickerConfig | null): void {
  defaultStickerConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureStickerConfig(): Promise<void> {
  await ensureConfigSnapshot(defaultStickerConfigCache, loadStickerConfig);
}

/**
 * 默认贴纸配置只读当前线程已校验的快照，不在运行期回退读盘。
 * @returns 当前线程已接管的贴纸包配置。
 */
export function getStickerConfig(): StickerConfig {
  const config: StickerConfig | null = defaultStickerConfigCache.current;
  if (config === null) {
    throw new Error(`Sticker configuration was not initialized from ${STICKERS_CONFIG_PATH}.`);
  }
  return config;
}

/**
 * 启动恢复读取已校验快照；真正缺省时跳过贴纸目录白名单对账。
 * @returns 已配置的贴纸包 short name 列表；配置缺省时返回 null。
 */
export function stickerPacksForRecovery(): readonly string[] | null {
  return defaultStickerConfigCache.current?.packs ?? null;
}
