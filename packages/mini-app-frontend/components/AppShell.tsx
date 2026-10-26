import type React from "react";
import { MINI_APP_TAB_KEYS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { getTelegramWebApp } from "../libs/telegram";
import { CloseSvgIcon, LockSvgIcon, MenuSvgIcon, TabSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, MiniAppTabKey, TelegramWebApp } from "../types/miniApp";
import { ChatsTab } from "./ChatsTab";
import { ConfirmModal } from "./ConfirmModal";
import { GalleryTab } from "./GalleryTab";
import { IdentitiesTab } from "./IdentitiesTab";
import { PrefsBar } from "./PrefsBar";
import { StatusTab } from "./StatusTab";
import { Toast } from "./Toast";
import { TotpManagerCard } from "./TotpManagerCard";

/**
 * 渲染解锁后的控制台外壳：顶栏（侧栏开关、当前页标题、偏好栏与锁定按钮）、折叠侧边栏导航与当前标签页内容。
 *
 * @returns React 节点
 */
export function AppShell(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const sidebarOpen: boolean = useMiniAppStore(
    (state: MiniAppUiStoreState): boolean => state.sidebarOpen
  );
  const sessionExpiresAt: number = useMiniAppStore(
    (state: MiniAppUiStoreState): number => state.sessionExpiresAt
  );
  const activeTab: MiniAppTabKey = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppTabKey => state.activeTab
  );
  const statusReady: boolean = useMiniAppStore(
    (state: MiniAppUiStoreState): boolean => state.statusReady
  );
  const setSidebarOpen: (open: boolean) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((open: boolean) => void) => state.setSidebarOpen
  );
  const toggleSidebar: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleSidebar
  );
  const setActiveTab: (tab: MiniAppTabKey) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((tab: MiniAppTabKey) => void) => state.setActiveTab
  );
  const lockSession: (reason: string) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((reason: string) => void) => state.lockSession
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const unsafeUserId: number | undefined = webApp?.initDataUnsafe?.user?.id;

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="topbar-left">
          <button
            type="button"
            className={`sidebar-toggle-btn ${sidebarOpen ? "active" : ""}`}
            aria-label={sidebarOpen ? t.sidebarCloseAria : t.sidebarOpenAria}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            <MenuSvgIcon size={18} />
          </button>
          <div className="topbar-titles">
            <h1 className="topbar-title">{t.tabs[activeTab]}</h1>
            <div className="topbar-sub">{t.appTitle}</div>
          </div>
        </div>

        <div className="topbar-right">
          <PrefsBar />
          {sessionExpiresAt > 0
            ? (
              <button
                type="button"
                className="btn icon-btn"
                onClick={(): void => {
                  lockSession(t.lockSessionToast);
                }}
              >
                <LockSvgIcon size={14} />
                <span>{t.lockButton}</span>
              </button>
            )
            : null}
        </div>
      </header>

      <div
        className={`sidebar-backdrop ${sidebarOpen ? "open" : ""}`}
        onClick={(): void => {
          setSidebarOpen(false);
        }}
        aria-hidden={!sidebarOpen}
      />

      <aside
        className={`sidebar-drawer ${sidebarOpen ? "open" : ""}`}
        aria-hidden={!sidebarOpen}
      >
        <div className="sidebar-header">
          <div>
            <div className="sidebar-title">{t.sidebarTitle}</div>
            <div className="sidebar-sub">{t.sidebarSubtitle}</div>
            <div style={{ marginTop: "6px" }}>
              <span className={`badge ${statusReady ? "ok" : ""}`}>
                {unsafeUserId !== undefined
                  ? `SuperAdmin #${unsafeUserId}`
                  : t.superAdminBadge}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn icon-btn"
            aria-label={t.sidebarCloseAria}
            onClick={(): void => {
              setSidebarOpen(false);
            }}
          >
            <CloseSvgIcon size={15} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {MINI_APP_TAB_KEYS.map((tabKey: MiniAppTabKey): React.JSX.Element => {
            const isActive: boolean = activeTab === tabKey;
            return (
              <button
                key={tabKey}
                type="button"
                className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                onClick={(): void => {
                  setActiveTab(tabKey);
                }}
              >
                <span className="sidebar-nav-icon">
                  <TabSvgIcon tabKey={tabKey} size={18} />
                </span>
                <span className="sidebar-nav-text">
                  <span className="sidebar-nav-label">{t.tabs[tabKey]}</span>
                  <span className="sidebar-nav-desc">
                    {t.tabDescriptions[tabKey]}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-hint">{t.sidebarFooterHint}</div>
        </div>
      </aside>

      <main className="app-main">
        {activeTab === "status" ? <StatusTab /> : null}

        {activeTab === "chats" ? <ChatsTab /> : null}

        {activeTab === "identities" ? <IdentitiesTab /> : null}

        {activeTab === "gallery" ? <GalleryTab /> : null}

        {activeTab === "totp" ? <TotpManagerCard /> : null}
      </main>

      <ConfirmModal />
      <Toast />
    </div>
  );
}
