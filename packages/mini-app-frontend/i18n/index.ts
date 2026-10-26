import { asPayloadRecord } from "../libs/record";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppFeatureKey,
  MiniAppLanguage,
  TelegramWebApp,
  TelegramWindow,
} from "../types/miniApp";
import type {
  MiniAppServerNoticeParams,
  MiniAppTranslations,
} from "../types/miniAppI18n";
import { getEnTranslations } from "./en";
import { getJaTranslations } from "./ja";
import { getZhTranslations } from "./zh";

const ZH_TRANSLATIONS: Readonly<MiniAppTranslations> = getZhTranslations();
const JA_TRANSLATIONS: Readonly<MiniAppTranslations> = getJaTranslations();
const EN_TRANSLATIONS: Readonly<MiniAppTranslations> = getEnTranslations();

/**
 * 根据语言键获取对应的杂鱼语气界面文案字典。
 *
 * @param language 语言键（`"zh"` | `"ja"` | `"en"`）
 * @returns 对应语言的只读文案字典
 */
export function getMiniAppTranslations(
  language: MiniAppLanguage
): Readonly<MiniAppTranslations> {
  if (language === "ja") return JA_TRANSLATIONS;
  if (language === "en") return EN_TRANSLATIONS;
  return ZH_TRANSLATIONS;
}

/**
 * 仅从浏览器 `navigator.languages` 与 `navigator.language` 推断默认显示语言（缺省为中文 `"zh"`），供外部访问拦截页使用。
 *
 * @returns 浏览器默认语言键（`"zh"` | `"ja"` | `"en"`）
 */
export function detectBrowserDefaultLanguage(): MiniAppLanguage {
  const tgWindow: TelegramWindow = globalThis;
  const candidates: readonly string[] | undefined = tgWindow.navigator?.languages;
  if (candidates !== undefined) {
    for (const item of candidates) {
      const normalized: string = item.trim().toLowerCase();
      if (normalized.startsWith("zh")) return "zh";
      if (normalized.startsWith("ja")) return "ja";
      if (normalized.startsWith("en")) return "en";
    }
  }
  const primary: string = (tgWindow.navigator?.language ?? "zh")
    .trim()
    .toLowerCase();
  if (primary.startsWith("ja")) return "ja";
  if (primary.startsWith("en")) return "en";
  return "zh";
}

/**
 * 从 Telegram WebApp 用户语言代码或浏览器 `navigator.language` 推断初始界面语言（缺省为中文 `"zh"`）。
 *
 * @returns 初始语言键
 */
export function detectInitialMiniAppLanguage(): MiniAppLanguage {
  const tgWindow: TelegramWindow = globalThis;
  const webApp: Readonly<TelegramWebApp> | undefined = tgWindow.Telegram?.WebApp;
  const tgCode: string | undefined = webApp?.initDataUnsafe?.user?.language_code;
  if (tgCode !== undefined && tgCode.trim().length > 0) {
    const normalized: string = tgCode.trim().toLowerCase();
    if (normalized.startsWith("ja")) return "ja";
    if (normalized.startsWith("en")) return "en";
    return "zh";
  }
  return detectBrowserDefaultLanguage();
}

/**
 * 从服务端响应对象、Error 实例（含 `cause`）或显式参数对象提取多语言提示插值字段。
 *
 * @param source 响应载荷、`Error` 实例或插值参数对象
 * @returns 归一化后的插值参数对象
 */
export function extractServerNoticeParams(
  source: unknown
): Readonly<MiniAppServerNoticeParams> | undefined {
  const raw: unknown = source instanceof Error ? source.cause : source;
  const record: Record<string, unknown> = asPayloadRecord(raw);
  if (Object.keys(record).length === 0) return undefined;
  return {
    mood:
      typeof record.mood === "string"
        ? record.mood
        : typeof record.currentMood === "string"
          ? record.currentMood
          : undefined,
    feature:
      typeof record.feature === "string"
        ? (record.feature as MiniAppFeatureKey)
        : undefined,
    configFile: typeof record.configFile === "string" ? record.configFile : undefined,
    id: typeof record.id === "number" ? record.id : undefined,
    key:
      typeof record.key === "string"
        ? (record.key as WhitelistPermissionKey)
        : undefined,
    value: typeof record.value === "boolean" ? record.value : undefined,
    persisted: typeof record.persisted === "boolean" ? record.persisted : undefined,
    affectedChats:
      typeof record.affectedChats === "number" ? record.affectedChats : undefined,
    totalChats: typeof record.totalChats === "number" ? record.totalChats : undefined,
    targetList:
      record.targetList === "whitelist" || record.targetList === "blocklist"
        ? record.targetList
        : undefined,
    addedCount:
      typeof record.addedCount === "number"
        ? record.addedCount
        : Array.isArray(record.addedIds)
          ? record.addedIds.length
          : undefined,
    skippedCount:
      typeof record.skippedCount === "number"
        ? record.skippedCount
        : Array.isArray(record.skippedIds)
          ? record.skippedIds.length
          : undefined,
    duplicateCount:
      typeof record.duplicateCount === "number"
        ? record.duplicateCount
        : Array.isArray(record.duplicateIds)
          ? record.duplicateIds.length
          : undefined,
    fileName: typeof record.fileName === "string" ? record.fileName : undefined,
    width: typeof record.width === "number" ? record.width : undefined,
    height: typeof record.height === "number" ? record.height : undefined,
    remainingAttempts:
      typeof record.remainingAttempts === "number"
        ? record.remainingAttempts
        : undefined,
    remainingMinutes:
      typeof record.remainingMinutes === "number"
        ? record.remainingMinutes
        : undefined,
  };
}

export type {
  MiniAppServerNoticeParams,
  MiniAppTranslations,
} from "../types/miniAppI18n";
