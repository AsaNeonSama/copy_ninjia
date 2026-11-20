import { Fragment, memo, startTransition, useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS,
  MINI_APP_TAB_KEYS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { getTelegramWebApp } from "../libs/telegram";
import { ChatsPage } from "../pages/ChatsPage";
import { ConfigsPage } from "../pages/ConfigsPage";
import { GalleryPage } from "../pages/GalleryPage";
import { IdentitiesPage } from "../pages/IdentitiesPage";
import { StatusPage } from "../pages/StatusPage";
import { TotpPage } from "../pages/TotpPage";
import { CloseSvgIcon, LockSvgIcon, MenuSvgIcon, TabSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { TelegramWebApp } from "../types/miniApp/host";
import type { MiniAppLanguage, MiniAppTabKey } from "../types/miniApp/ui";
import { PrefsBar } from "./PrefsBar";
import { Toast } from "./Toast";

/** `AppMainContent` 主内容出口的属性参数。 */
interface AppMainContentProps {
  /** 主内容区当前挂载渲染的导航标签键。 */
  readonly activeTab: MiniAppTabKey;
  /** 侧边栏抽屉当前是否处于展开态或收起滑动过渡中。 */
  readonly sidebarMotionActive: boolean;
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
    case "configs":
      return <ConfigsPage />;
    case "gallery":
      return <GalleryPage />;
    case "totp":
      return <TotpPage />;
  }
}

/**
 * 渲染主内容区已就绪的标签页组件；按传入的 `activeTab` 与 `sidebarMotionActive` 浅比较隔离，
 * 在侧边栏展开及收起滑动过渡期间于 `<main>` 上挂载 `data-sidebar-motion="active"` 屏蔽指针穿透，
 * 且从展开态转入收起态的首帧保持 `sidebarMotionActive` 恒为 `true` 而不触发主页面重渲染；
 * 挂载 `"configs"` 页面时附加 `.app-main-configs` 弹性高度修饰类，其余标签页保持文档流自然高度。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function AppMainContentView({
  activeTab,
  sidebarMotionActive,
}: AppMainContentProps): React.JSX.Element {
  return (
    <main
      className={
        activeTab === "configs" ? "app-main app-main-configs" : "app-main"
      }
      data-sidebar-motion={sidebarMotionActive ? "active" : undefined}
    >
      {renderActiveTabPage(activeTab)}
    </main>
  );
}

/** 按 `activeTab` 与 `sidebarMotionActive` 浅比较跳过无关重渲染的主页面容器。 */
const AppMainContent: React.MemoExoticComponent<typeof AppMainContentView> =
  memo(AppMainContentView);

/** `syncSidebarTabRenderEffect` 抽屉收起与主页面切页定时解耦副作用的入参。 */
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
  /** 记录当前是否有抽屉收起触发的切页定时排期在途的引用。 */
  readonly deferPendingRef: React.RefObject<boolean>;
  /** 更新主内容区渲染标签键的状态写入函数。 */
  readonly setRenderedTab: (nextTab: MiniAppTabKey) => void;
}

/**
 * 协调侧边栏收起滑动过渡与主内容区切页挂载的兜底定时器排期：
 * 1. `renderedTab` 已与 `activeTab` 一致时重置在途标志并仅同步历史引用。
 * 2. 非侧边栏收起触发的切页，或宿主缺少 `setTimeout` / `clearTimeout` 时立即切换 `renderedTab`。
 * 3. 从展开态侧边栏点击切页（含切页排期尚未落地时再次切换）时，先保持当前主页面不动，待抽屉 `transform` `transitionend` 提前结算或 `MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS` 兜底定时器到期后在 `startTransition` 中挂载目标页；清理时撤销未到期的定时器。
 *
 * @param options 当前激活与已渲染标签键、侧边栏状态、历史引用及状态更新函数
 * @returns 清理在途定时器的函数（无需排期时返回 `undefined`）
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

  const scheduleTimeout: typeof globalThis.setTimeout | undefined =
    globalThis.setTimeout;
  const cancelTimeout: typeof globalThis.clearTimeout | undefined =
    globalThis.clearTimeout;
  if (typeof scheduleTimeout !== "function" || typeof cancelTimeout !== "function") {
    deferPendingRef.current = false;
    setRenderedTab(activeTab);
    return undefined;
  }

  deferPendingRef.current = true;
  let cancelled: boolean = false;
  let timerHandle: ReturnType<typeof globalThis.setTimeout> | null =
    scheduleTimeout((): void => {
      timerHandle = null;
      if (cancelled || !deferPendingRef.current) return;
      deferPendingRef.current = false;
      startTransition((): void => {
        setRenderedTab(activeTab);
      });
    }, MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS);

  return (): void => {
    cancelled = true;
    if (timerHandle !== null) {
      cancelTimeout(timerHandle);
      timerHandle = null;
    }
  };
}

/**
 * 渲染解锁后的控制台外壳：顶层 `<Fragment>` 并列挂载主文档壳层 `.app-shell`（仅含顶栏与主内容出口）、
 * 独立视口遮罩 `.sidebar-backdrop`、独立抽屉 `.sidebar-drawer` 与顶部 `Toast`；
 * 顶栏标题与侧栏激活态即时跟随 `activeTab`，从展开侧栏切页时主内容区在 `.sidebar-drawer` 的 `transform` `transitionend`
 * 或 `MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS` 兜底定时器收起结算后切换至目标标签页，
 * 并在侧栏展开及收起滑动全程维持 `data-sidebar-motion="active"` 屏蔽主内容区指针穿透；
 * `renderedTab` 为 `"configs"` 时同步挂载 `.app-shell-configs` 全视口弹性布局修饰类。
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
  const [prevSidebarOpen, setPrevSidebarOpen]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(sidebarOpen);
  const [sidebarClosing, setSidebarClosing]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);

  if (prevSidebarOpen !== sidebarOpen) {
    setPrevSidebarOpen(sidebarOpen);
    setSidebarClosing(!sidebarOpen && prevSidebarOpen);
  }

  const sidebarMotionActive: boolean =
    sidebarOpen || sidebarClosing || prevSidebarOpen;

  const wasSidebarOpenRef: React.RefObject<boolean> = useRef<boolean>(sidebarOpen);
  const prevActiveTabRef: React.RefObject<MiniAppTabKey> =
    useRef<MiniAppTabKey>(activeTab);
  const deferPendingRef: React.RefObject<boolean> = useRef<boolean>(false);
  const pendingTabTimerCleanupRef: React.RefObject<(() => void) | null> =
    useRef<(() => void) | null>(null);
  const closeSidebar: () => void = useCallback((): void => {
    setSidebarOpen(false);
  }, [setSidebarOpen]);
  const handleDrawerTransitionEnd: (
    event: React.TransitionEvent<HTMLElement>
  ) => void = useCallback(
    (event: React.TransitionEvent<HTMLElement>): void => {
      if (
        sidebarOpen ||
        event.target !== event.currentTarget ||
        event.propertyName !== "transform"
      ) {
        return;
      }
      setSidebarClosing(false);
      if (renderedTab !== activeTab) {
        deferPendingRef.current = false;
        pendingTabTimerCleanupRef.current?.();
        pendingTabTimerCleanupRef.current = null;
        startTransition((): void => {
          setRenderedTab(activeTab);
        });
      }
    },
    [activeTab, renderedTab, sidebarOpen]
  );

  useEffect((): (() => void) | undefined => {
    if (!sidebarClosing || sidebarOpen) {
      return undefined;
    }
    const timer: ReturnType<typeof globalThis.setTimeout> =
      globalThis.setTimeout((): void => {
        setSidebarClosing(false);
      }, MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS);
    return (): void => {
      globalThis.clearTimeout(timer);
    };
  }, [sidebarClosing, sidebarOpen]);

  useEffect((): (() => void) | undefined => {
    const cleanup: (() => void) | undefined = syncSidebarTabRenderEffect({
      activeTab,
      sidebarOpen,
      renderedTab,
      wasSidebarOpenRef,
      prevActiveTabRef,
      deferPendingRef,
      setRenderedTab,
    });
    pendingTabTimerCleanupRef.current = cleanup ?? null;
    if (cleanup === undefined) {
      return undefined;
    }
    return (): void => {
      if (pendingTabTimerCleanupRef.current === cleanup) {
        pendingTabTimerCleanupRef.current = null;
      }
      cleanup();
    };
  }, [activeTab, renderedTab, sidebarOpen]);

  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const unsafeUserId: number | undefined = webApp?.initDataUnsafe?.user?.id;

  return (
    <Fragment>
      <div
        className={
          renderedTab === "configs" ? "app-shell app-shell-configs" : "app-shell"
        }
      >
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

        <AppMainContent
          activeTab={renderedTab}
          sidebarMotionActive={sidebarMotionActive}
        />
      </div>

      <div
        className={`sidebar-backdrop ${sidebarOpen ? "open" : ""}`}
        onClick={closeSidebar}
        aria-hidden={!sidebarOpen}
      />

      <aside
        className={`sidebar-drawer ${sidebarOpen ? "open" : ""}`}
        aria-hidden={!sidebarOpen}
        onTransitionEnd={handleDrawerTransitionEnd}
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

      <Toast />
    </Fragment>
  );
}
