import { useEffect } from "react";
import type React from "react";
import { AccessDeniedPage } from "./components/AccessDeniedPage";
import { AppShell } from "./components/AppShell";
import { AuthGate } from "./components/AuthGate";
import { PrefsBar } from "./components/PrefsBar";
import { AuthGateSkeleton } from "./components/skeletons/AuthGateSkeleton";
import { detectBrowserDefaultLanguage, getMiniAppTranslations } from "./i18n";
import { applyMiniAppThemeToDocument, useMiniAppStore } from "./store/app";
import type { MiniAppGateState, MiniAppUiStoreState } from "./store/app";
import type { MiniAppThemeMode } from "./types/miniApp";

/**
 * Copy Ninja Mini App 根 React 应用组件：同步主题到宿主，在 `checking` 阶段发起访问预检，
 * 并按门禁状态渲染预检骨架、拦截页、密码 / TOTP 门禁或解锁后的控制台外壳。
 *
 * @returns React 根视图
 */
export function App(): React.JSX.Element {
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

  useEffect((): (() => void) => clearTimers, [clearTimers]);

  useEffect((): void => {
    if (gateState !== "checking") return;
    void runAccessPrecheck();
  }, [gateState, runAccessPrecheck]);

  if (gateState === "checking") {
    return (
      <div className="auth-gate-wrap animate-fade-in">
        <div className="gate-top-prefs"><PrefsBar /></div>
        <AuthGateSkeleton
          ariaLabel={getMiniAppTranslations(detectBrowserDefaultLanguage()).gate.checkingText}
        />
      </div>
    );
  }

  if (gateState === "denied") {
    return <AccessDeniedPage />;
  }

  if (gateState === "password") {
    return <AuthGate />;
  }

  return <AppShell />;
}
