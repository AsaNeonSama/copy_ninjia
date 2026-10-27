import type React from "react";
import { MINI_APP_LANGUAGES } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { GlobeSvgIcon, MoonSvgIcon, SunSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, MiniAppThemeMode } from "../types/miniApp";

/**
 * 渲染界面语言切换胶囊组与亮/暗主题切换按钮。
 *
 * @returns React 节点
 */
export function PrefsBar(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const theme: MiniAppThemeMode = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppThemeMode => state.theme
  );
  const setLanguage: (lang: MiniAppLanguage) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((lang: MiniAppLanguage) => void) => state.setLanguage
  );
  const toggleTheme: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleTheme
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  return (
    <div className="prefs-bar">
      <div className="lang-pill-group" role="group" aria-label="Language">
        <GlobeSvgIcon size={14} className="lang-globe-icon" />
        {MINI_APP_LANGUAGES.map((lang: MiniAppLanguage): React.JSX.Element => {
          const label: string = getMiniAppTranslations(lang).languageLabel;
          return (
            <button
              key={lang}
              type="button"
              className={`lang-pill-btn ${language === lang ? "active" : ""}`}
              onClick={(): void => {
                setLanguage(lang);
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="btn icon-btn theme-toggle-btn"
        onClick={toggleTheme}
        title={theme === "dark" ? t.themeLightLabel : t.themeDarkLabel}
      >
        {theme === "dark" ? <SunSvgIcon size={14} /> : <MoonSvgIcon size={14} />}
        <span>{theme === "dark" ? t.themeLightLabel : t.themeDarkLabel}</span>
      </button>
    </div>
  );
}
