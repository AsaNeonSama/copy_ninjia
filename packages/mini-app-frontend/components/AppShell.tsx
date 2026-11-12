import { memo, startTransition, useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_TAB_KEYS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { getTelegramWebApp } from "../libs/telegram";
import { ChatsPage } from "../pages/ChatsPage";
import { GalleryPage } from "../pages/GalleryPage";
import { IdentitiesPage } from "../pages/IdentitiesPage";
import { StatusPage } from "../pages/StatusPage";
import { TotpPage } from "../pages/TotpPage";
import { CloseSvgIcon, LockSvgIcon, MenuSvgIcon, TabSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, MiniAppTabKey, TelegramWebApp } from "../types/miniApp";
import { getFrameMotionHost } from "./animations/frameMotion";
import type { FrameMotionHost } from "./animations/frameMotion";
import { ConfirmModal } from "./ConfirmModal";
import { PrefsBar } from "./PrefsBar";
import { Toast } from "./Toast";

/** `AppMainContent` 主内容出口的属性参数。 */
interface AppMainContentProps {
  /** 主内容区当前挂载渲染的导航标签键。 */
  readonly activeTab: MiniAppTabKey;
}

/**
 * 按当前激活标签键渲染对应顶层页面组件。
 *
 * @param activeTab 当前激活的导航标签键
 * @returns 顶层页面节点
 */
function renderActiveTabPage(activeTab: MiniAppTabKey): React.JSX.Element {
  switch (activeTab) {
    case "status":
      return <StatusPage />;
    case "chats":
      return <ChatsPage />;
    case "identities":
      return <IdentitiesPage />;
    case "gallery":
      return <GalleryPage />;
    case "totp":
      return <TotpPage />;
  }
}

/**
 * 渲染主内容区已就绪的标签页组件；按传入的 `activeTab` 与外壳 `sidebarOpen` 隔离，开关侧边栏抽屉及抽屉收起首帧时不触发主页面重渲染。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function AppMainContentView({
  activeTab,
}: AppMainContentProps): React.JSX.Element {
  return <main className="app-main">{renderActiveTabPage(activeTab)}</main>;
}

/** 按 `activeTab` 浅比较跳过重渲染的主页面容器。 */
const AppMainContent: React.MemoExoticComponent<typeof AppMainContentView> =
  memo(AppMainContentView);

/** `syncSidebarTabRenderEffect` 抽屉收起与主页面切页帧级解耦副作用的入参。 */
export interface SyncSidebarTabRenderEffectOptions {
  /** 根仓库当前激活的导航标签键。 */
  readonly activeTab: MiniAppTabKey;
  /** 侧边栏导航抽屉当前是否处于展开态。 */
  readonly sidebarOpen: boolean;
  /** 主内容区当前已挂载渲染的导航标签键。 */
  readonly renderedTab: MiniAppTabKey;
  /** 记录上一轮提交时侧边栏是否处于展开态的引用。 */
  readonly wasSidebarOpenRef: React.RefObject<boolean>;
  /** 记录上一轮提交时根仓库激活标签键的引用。 */
  readonly prevActiveTabRef: React.RefObject<MiniAppTabKey>;
  /** 记录当前是否有抽屉收起触发的跨帧切页排期在途的引用。 */
  readonly deferPendingRef: React.RefObject<boolean>;
  /** 更新主内容区渲染标签键的状态写入函数。 */
  readonly setRenderedTab: (nextTab: MiniAppTabKey) => void;
}

/**
 * 协调侧边栏收起过渡与主内容区切页挂载：
 * 主内容区已与 `activeTab` 对齐时仅同步历史引用；非侧边栏收起触发的切页或宿主缺少 `requestAnimationFrame` 时立即对齐；
 * 从展开态侧边栏点击切换到其他标签（含切页排期尚未落地期间再次点击其他标签）时，保留当前主页面让抽屉收起第 1 帧先行提交给合成器，
 * 经双 `requestAnimationFrame` 后在 `startTransition` 中挂载目标标签页，清理时通过 `cancelAnimationFrame` 撤销未完成的帧回调。
 *
 * @param options 当前激活与已渲染标签键、侧边栏状态、历史引用及状态更新函数
 * @returns 清理在途动画帧回调的函数（无需排期时返回 `undefined`）
 */
export function syncSidebarTabRenderEffect({
  activeTab,
  sidebarOpen,
  renderedTab,
  wasSidebarOpenRef,
  prevActiveTabRef,
  deferPendingRef,
  setRenderedTab,
}: SyncSidebarTabRenderEffectOptions): (() => void) | undefined {
  const wasSidebarOpen: boolean = wasSidebarOpenRef.current;
  const activeTabChanged: boolean = prevActiveTabRef.current !== activeTab;
  wasSidebarOpenRef.current = sidebarOpen;
  prevActiveTabRef.current = activeTab;

  if (renderedTab === activeTab) {
    deferPendingRef.current = false;
    return undefined;
  }

  const shouldDeferForDrawerClose: boolean =
    !sidebarOpen && activeTabChanged && (wasSidebarOpen || deferPendingRef.current);
  if (!shouldDeferForDrawerClose) {
    deferPendingRef.current = false;
    setRenderedTab(activeTab);
    return undefined;
  }

  const host: FrameMotionHost = getFrameMotionHost();
  const requestFrame: ((callback: (now: number) => void) => number) | undefined =
    host.requestAnimationFrame;
  const cancelFrame: ((handle: number) => void) | undefined =
    host.cancelAnimationFrame;
  if (typeof requestFrame !== "function" || typeof cancelFrame !== "function") {
    deferPendingRef.current = false;
    setRenderedTab(activeTab);
    return undefined;
  }

  deferPendingRef.current = true;
  let cancelled: boolean = false;
  let frameHandle: number | null = requestFrame((): void => {
    if (cancelled) return;
    frameHandle = requestFrame((): void => {
      frameHandle = null;
      if (cancelled) return;
      deferPendingRef.current = false;
      startTransition((): void => {
        setRenderedTab(activeTab);
      });
    });
  });

  return (): void => {
    cancelled = true;
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  };
}

/**
 * 渲染解锁后的控制台外壳：顶栏（侧栏开关、当前页标题、偏好栏与锁定按钮）、折叠侧边栏导航与当前标签页内容；
 * 顶栏标题与侧栏激活态即时跟随 `activeTab`，从展开侧栏切页时主内容区经双帧解耦后切换至目标标签页。
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
  const logout: (reason: string) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((reason: string) => void) => state.logout
  );
  const [renderedTab, setRenderedTab]: [
    MiniAppTabKey,
    React.Dispatch<React.SetStateAction<MiniAppTabKey>>
  ] = useState<MiniAppTabKey>(activeTab);
  const wasSidebarOpenRef: React.RefObject<boolean> = useRef<boolean>(sidebarOpen);
  const prevActiveTabRef: React.RefObject<MiniAppTabKey> =
    useRef<MiniAppTabKey>(activeTab);
  const deferPendingRef: React.RefObject<boolean> = useRef<boolean>(false);
  const closeSidebar: () => void = useCallback((): void => {
    setSidebarOpen(false);
  }, [setSidebarOpen]);

  useEffect(
    (): (() => void) | undefined =>
      syncSidebarTabRenderEffect({
        activeTab,
        sidebarOpen,
        renderedTab,
        wasSidebarOpenRef,
        prevActiveTabRef,
        deferPendingRef,
        setRenderedTab,
      }),
    [activeTab, renderedTab, sidebarOpen]
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
            <MenuSvgIcon size={22} />
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
                  logout(t.lockSessionToast);
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
        onClick={closeSidebar}
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
            onClick={closeSidebar}
          >
            <CloseSvgIcon size={16} />
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

      <AppMainContent activeTab={renderedTab} />

      <ConfirmModal />
      <Toast />
    </div>
  );
}
