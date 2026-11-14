import { Fragment, useEffect } from "react";
import type React from "react";
import { AppShell } from "./components/AppShell";
import { ConfirmModal } from "./components/ConfirmModal";
import { getMiniAppTranslations } from "./i18n";
import { AccessDeniedPage } from "./pages/AccessDeniedPage";
import { AuthGatePage } from "./pages/AuthGatePage";
import { applyMiniAppThemeToDocument, useMiniAppStore } from "./store/app";
import type { MiniAppGateState, MiniAppUiStoreState } from "./store/app";
import type { MiniAppLanguage, MiniAppThemeMode, TelegramWindow } from "./types/miniApp";
import type { MiniAppTranslations } from "./types/miniAppI18n";

/**
 * 按非 `checking` 门禁状态渲染对应主视图节点。
 *
 * @param gateState 已完成预检后的门禁状态
 * @returns 门禁页、拦截页或解锁后的控制台外壳节点
 */
function renderGateView(
  gateState: Exclude<MiniAppGateState, "checking">
): React.JSX.Element {
  switch (gateState) {
    case "denied":
      return <AccessDeniedPage />;
    case "password":
      return <AuthGatePage />;
    case "unlocked":
      return <AppShell />;
  }
}

/**
 * Copy Ninja Mini App 根 React 应用组件：同步主题到宿主，在 `checking` 阶段首先请求首个服务端预检接口校验请求头，
 * 服务端完成校验前不渲染任何骨架；校验完成后在顶层 `<Fragment>` 下渲染拦截页、密码 / TOTP 门禁或控制台外壳，并常驻同级挂载 `<ConfirmModal />`，跨门禁状态切换时不卸载确认弹窗退场过渡。
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

  return (
    <Fragment>
      {renderGateView(gateState)}
      <ConfirmModal />
    </Fragment>
  );
}
