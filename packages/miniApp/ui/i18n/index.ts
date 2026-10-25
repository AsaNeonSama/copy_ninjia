import type {
  MiniAppLanguage,
  TelegramWebApp,
  TelegramWindow,
} from "../../../types/miniApp";
import type { MiniAppTranslations } from "../../../types/miniAppI18n";
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

export type { MiniAppTranslations } from "../../../types/miniAppI18n";
