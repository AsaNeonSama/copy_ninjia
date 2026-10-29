import { Fragment } from "react";
import type React from "react";
import {
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_LANGUAGES,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { GlobeSvgIcon, MoonSvgIcon, SunSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, MiniAppThemeMode } from "../types/miniApp";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";

/**
 * 渲染界面语言球标折叠下拉菜单（带弹出与关闭收起动画）与亮/暗主题切换按钮。
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
  const langMenuOpen: boolean = useMiniAppStore(
    (state: MiniAppUiStoreState): boolean => state.langMenuOpen
  );
  const setLanguage: (lang: MiniAppLanguage) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((lang: MiniAppLanguage) => void) => state.setLanguage
  );
  const toggleLangMenu: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleLangMenu
  );
  const closeLangMenu: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.closeLangMenu
  );
  const toggleTheme: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleTheme
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const {
    displayValue: displayMenuOpen,
    isClosing,
  }: Readonly<DelayedUnmountState<true>> = useDelayedUnmount(
    langMenuOpen ? true : null,
    MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS
  );

  return (
    <div className="prefs-bar">
      <div className="lang-dropdown">
        <button
          type="button"
          className={`btn icon-btn lang-menu-btn ${langMenuOpen ? "active" : ""}`}
          aria-haspopup="menu"
          aria-expanded={langMenuOpen}
          aria-label={t.languageMenuAria}
          title={t.languageMenuAria}
          onClick={toggleLangMenu}
        >
          <GlobeSvgIcon language={language} size={20} className="lang-globe-icon" />
        </button>
        {displayMenuOpen !== null ? (
          <Fragment>
            <div
              className={`lang-menu-backdrop ${isClosing ? "closing" : ""}`}
              aria-hidden="true"
              onClick={(): void => {
                if (!isClosing) {
                  closeLangMenu();
                }
              }}
            />
            <div
              className={`lang-menu-popover ${isClosing ? "closing" : ""}`}
              role="menu"
              aria-label={t.languageMenuAria}
              aria-hidden={isClosing}
            >
              {MINI_APP_LANGUAGES.map((lang: MiniAppLanguage): React.JSX.Element => {
                const isActive: boolean = language === lang;
                const label: string = getMiniAppTranslations(lang).languageLabel;
                const badgeCode: string = lang === "zh" ? "CN" : lang.toUpperCase();
                return (
                  <button
                    key={lang}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={isClosing}
                    className={`lang-menu-item ${isActive ? "active" : ""}`}
                    onClick={(): void => {
                      setLanguage(lang);
                    }}
                  >
                    <span className="lang-menu-item-label">{label}</span>
                    <span className="lang-menu-item-code">{badgeCode}</span>
                  </button>
                );
              })}
            </div>
          </Fragment>
        ) : null}
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
