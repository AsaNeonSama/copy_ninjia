import { create } from "zustand";
import type { UseBoundStore, StoreApi } from "zustand";
import { MINI_APP_LANGUAGES } from "./consts/miniApp";
import type {
  MiniAppAccessDiagnostics,
  MiniAppLanguage,
  MiniAppStatusView,
  MiniAppTabKey,
  MiniAppThemeMode,
  TelegramWebApp,
  TelegramWindow,
} from "./types/miniApp";
import type { MiniAppAuthMode } from "./types/miniAppTotp";
import { clearMiniAppAssetToken, clearMiniAppSessionToken } from "./api";
import { detectInitialMiniAppLanguage } from "./i18n";

/** Mini App 门禁状态枚举。 */
export type MiniAppGateState = "checking" | "denied" | "password" | "unlocked";

/** Mini App 顶部 Toast 提示色调。 */
export type MiniAppToastTone = "info" | "warning" | "danger";

/** Mini App 自定义确认弹窗状态。 */
export interface MiniAppConfirmModalState {
  /** 确认提示正文。 */
  readonly message: string;
  /** 确认按钮色调（默认 `"danger"`）。 */
  readonly tone: "danger" | "primary";
  /** 内部 Promise 结算回调。 */
  readonly resolve: (accepted: boolean) => void;
}

/** Zustand 管理的 Mini App 全局 UI 状态与动作接口。 */
export interface MiniAppUiStoreState {
  readonly language: MiniAppLanguage;
  readonly theme: MiniAppThemeMode;
  readonly sidebarOpen: boolean;
  readonly gateState: MiniAppGateState;
  readonly authMode: MiniAppAuthMode;
  readonly deniedDiag: Readonly<MiniAppAccessDiagnostics> | null;
  readonly sessionExpiresAt: number;
  readonly activeTab: MiniAppTabKey;
  readonly statusReady: boolean;
  readonly initialStatus: Readonly<MiniAppStatusView> | null;
  readonly toastText: string;
  readonly toastTone: MiniAppToastTone;
  readonly confirmModal: Readonly<MiniAppConfirmModalState> | null;

  readonly setLanguage: (language: MiniAppLanguage) => void;
  readonly cycleLanguage: () => void;
  readonly setTheme: (theme: MiniAppThemeMode) => void;
  readonly toggleTheme: () => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly toggleSidebar: () => void;
  readonly setGateState: (gateState: MiniAppGateState) => void;
  readonly setAuthMode: (authMode: MiniAppAuthMode) => void;
  readonly setDeniedDiag: (diag: Readonly<MiniAppAccessDiagnostics> | null) => void;
  readonly setSessionExpiresAt: (expiresAt: number) => void;
  readonly setActiveTab: (tab: MiniAppTabKey) => void;
  readonly setStatusReady: (ready: boolean) => void;
  readonly setInitialStatus: (status: Readonly<MiniAppStatusView> | null) => void;
  readonly showToast: (text: string, tone?: MiniAppToastTone) => void;
  readonly clearToast: () => void;
  readonly requestConfirm: (
    message: string,
    tone?: "danger" | "primary"
  ) => Promise<boolean>;
  readonly resolveConfirm: (accepted: boolean) => void;
  readonly lockSession: (noticeText?: string) => void;
}

/**
 * 返回 Mini App 初始主题模式（默认固定为亮色 `"light"`）。
 *
 * @returns 初始主题模式（`"light"`）
 */
export function detectInitialMiniAppTheme(): MiniAppThemeMode {
  return "light";
}

/**
 * 将当前主题模式同步至根节点 `data-theme` 属性及 Telegram WebApp 宿主背景色。
 *
 * @param theme 目标主题模式
 */
export function applyMiniAppThemeToDocument(theme: MiniAppThemeMode): void {
  const tgWindow: TelegramWindow = globalThis;
  tgWindow.document?.documentElement?.setAttribute?.("data-theme", theme);
  const webApp: Readonly<TelegramWebApp> | undefined = tgWindow.Telegram?.WebApp;
  const bgHex: string = theme === "light" ? "#eef2f6" : "#0f1722";
  const headerHex: string = theme === "light" ? "#ffffff" : "#182433";
  try {
    webApp?.setHeaderColor?.(headerHex);
    webApp?.setBackgroundColor?.(bgHex);
  } catch (_error: unknown) {
    // 忽略低版本客户端不支持颜色设置 API 的异常。
  }
}

/**
 * Mini App 全局 Zustand 状态仓库。
 */
export const useMiniAppStore: UseBoundStore<StoreApi<MiniAppUiStoreState>> =
  create<MiniAppUiStoreState>()(
    (
      set: (
        partial:
          | Partial<MiniAppUiStoreState>
          | ((state: MiniAppUiStoreState) => Partial<MiniAppUiStoreState>)
      ) => void,
      get: () => MiniAppUiStoreState
    ): MiniAppUiStoreState => ({
      language: detectInitialMiniAppLanguage(),
      theme: detectInitialMiniAppTheme(),
      sidebarOpen: false,
      gateState: "checking",
      authMode: "password",
      deniedDiag: null,
      sessionExpiresAt: 0,
      activeTab: "status",
      statusReady: false,
      initialStatus: null,
      toastText: "",
      toastTone: "info",
      confirmModal: null,

      setLanguage: (language: MiniAppLanguage): void => {
        set({ language });
      },

      cycleLanguage: (): void => {
        set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => {
          const currentIndex: number = MINI_APP_LANGUAGES.indexOf(state.language);
          const nextIndex: number =
            currentIndex < 0 ? 0 : (currentIndex + 1) % MINI_APP_LANGUAGES.length;
          return { language: MINI_APP_LANGUAGES[nextIndex] ?? "zh" };
        });
      },

      setTheme: (theme: MiniAppThemeMode): void => {
        applyMiniAppThemeToDocument(theme);
        set({ theme });
      },

      toggleTheme: (): void => {
        set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => {
          const nextTheme: MiniAppThemeMode = state.theme === "dark" ? "light" : "dark";
          applyMiniAppThemeToDocument(nextTheme);
          return { theme: nextTheme };
        });
      },

      setSidebarOpen: (open: boolean): void => {
        set({ sidebarOpen: open });
      },

      toggleSidebar: (): void => {
        set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
          sidebarOpen: !state.sidebarOpen,
        }));
      },

      setGateState: (gateState: MiniAppGateState): void => {
        set({ gateState });
      },

      setAuthMode: (authMode: MiniAppAuthMode): void => {
        set({ authMode });
      },

      setDeniedDiag: (diag: Readonly<MiniAppAccessDiagnostics> | null): void => {
        set({ deniedDiag: diag });
      },

      setSessionExpiresAt: (expiresAt: number): void => {
        set({ sessionExpiresAt: expiresAt });
      },

      setActiveTab: (tab: MiniAppTabKey): void => {
        set({ activeTab: tab, sidebarOpen: false });
      },

      setStatusReady: (ready: boolean): void => {
        set({ statusReady: ready });
      },

      setInitialStatus: (status: Readonly<MiniAppStatusView> | null): void => {
        set({ initialStatus: status });
      },

      showToast: (text: string, tone: MiniAppToastTone = "info"): void => {
        set({ toastText: text, toastTone: tone });
      },

      clearToast: (): void => {
        set({ toastText: "", toastTone: "info" });
      },

      requestConfirm: (
        message: string,
        tone: "danger" | "primary" = "danger"
      ): Promise<boolean> => {
        const prev: Readonly<MiniAppConfirmModalState> | null = get().confirmModal;
        if (prev !== null) {
          prev.resolve(false);
        }
        return new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
          set({
            confirmModal: {
              message,
              tone,
              resolve,
            },
          });
        });
      },

      resolveConfirm: (accepted: boolean): void => {
        const current: Readonly<MiniAppConfirmModalState> | null = get().confirmModal;
        set({ confirmModal: null });
        if (current !== null) {
          current.resolve(accepted);
        }
      },

      lockSession: (noticeText?: string): void => {
        clearMiniAppSessionToken();
        const current: Readonly<MiniAppConfirmModalState> | null = get().confirmModal;
        if (current !== null) {
          current.resolve(false);
        }
        set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
          sessionExpiresAt: 0,
          statusReady: false,
          initialStatus: null,
          sidebarOpen: false,
          confirmModal: null,
          gateState: "password",
          toastText: noticeText ?? state.toastText,
          toastTone: noticeText !== undefined ? "warning" : state.toastTone,
        }));
      },
    })
  );

/**
 * 重置 Mini App Zustand 状态仓库为默认初始状态（供单元测试使用）。
 */
export function resetMiniAppStoreForTest(): void {
  clearMiniAppAssetToken();
  const prev: Readonly<MiniAppConfirmModalState> | null =
    useMiniAppStore.getState().confirmModal;
  if (prev !== null) {
    prev.resolve(false);
  }
  useMiniAppStore.setState({
    language: detectInitialMiniAppLanguage(),
    theme: detectInitialMiniAppTheme(),
    sidebarOpen: false,
    gateState: "checking",
    authMode: "password",
    deniedDiag: null,
    sessionExpiresAt: 0,
    activeTab: "status",
    statusReady: false,
    initialStatus: null,
    toastText: "",
    toastTone: "info",
    confirmModal: null,
  });
}
