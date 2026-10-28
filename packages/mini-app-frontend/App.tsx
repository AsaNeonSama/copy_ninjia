import { useEffect } from "react";
import type React from "react";
import { AppShell } from "./components/AppShell";
import { getMiniAppTranslations } from "./i18n";
import { AccessDeniedPage } from "./pages/AccessDeniedPage";
import { AuthGatePage } from "./pages/AuthGatePage";
import { applyMiniAppThemeToDocument, useMiniAppStore } from "./store/app";
import type { MiniAppGateState, MiniAppUiStoreState } from "./store/app";
import type { MiniAppLanguage, MiniAppThemeMode, TelegramWindow } from "./types/miniApp";
import type { MiniAppTranslations } from "./types/miniAppI18n";

/**
 * Copy Ninja Mini App 根 React 应用组件：同步主题到宿主，在 `checking` 阶段首先请求首个服务端预检接口校验请求头，
 * 服务端完成校验前不渲染任何骨架，校验完成后按门禁状态渲染拦截页、密码 / TOTP 门禁或解锁后的控制台外壳。
 *
 * @returns React 根视图
 */
export function App(): React.JSX.Element | null {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const theme: MiniAppThemeMode = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppThemeMode => state.theme
  );
  const gateState: MiniAppGateState = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppGateState => state.gateState
  );
  const runAccessPrecheck: () => Promise<void> = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => Promise<void>) => state.runAccessPrecheck
  );
  const clearTimers: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.clearTimers
  );

  useEffect((): void => {
    applyMiniAppThemeToDocument(theme);
  }, [theme]);

  useEffect((): void => {
    const tgWindow: TelegramWindow = globalThis;
    if (tgWindow.document !== undefined) {
      tgWindow.document.title = t.appTitle;
      const htmlLang: string =
        language === "ja" ? "ja" : language === "en" ? "en-US" : "zh-CN";
      tgWindow.document.documentElement?.setAttribute?.("lang", htmlLang);
    }
  }, [language, t.appTitle]);

  useEffect((): (() => void) => clearTimers, [clearTimers]);

  useEffect((): void => {
    if (gateState !== "checking") return;
    void runAccessPrecheck();
  }, [gateState, runAccessPrecheck]);

  if (gateState === "checking") {
    return null;
  }

  if (gateState === "denied") {
    return <AccessDeniedPage />;
  }

  if (gateState === "password") {
    return <AuthGatePage />;
  }

  return <AppShell />;
}
