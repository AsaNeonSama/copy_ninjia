import { create } from "zustand";
import type { UseBoundStore, StoreApi } from "zustand";
import { loginMiniAppWithPassword } from "../api/authLogin";
import { precheckMiniAppAccess } from "../api/authPrecheck";
import { MINI_APP_LANGUAGES, MINI_APP_TOAST_DURATION_MS } from "../consts/miniApp";
import {
  detectInitialMiniAppLanguage,
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import {
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  readMiniAppSessionToken,
} from "../libs/credentials";
import { buildFallbackDiagnostics } from "../libs/diagnostics";
import { errorMessage } from "../libs/errorMessage";
import type {
  MiniAppAccessDiagnostics,
  MiniAppLanguage,
  MiniAppLoginSuccessResponse,
  MiniAppPrecheckResult,
  MiniAppTabKey,
  MiniAppThemeMode,
  TelegramWebApp,
  TelegramWindow,
} from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";

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

/**
 * `App` 根组件的 Zustand 全局状态与动作接口：界面偏好、导航、Toast、确认弹窗，以及鉴权门禁
 * （预检、密码 / TOTP 登录、45 分钟会话到期锁定）。各页面 store 经 `notify`、`requestConfirm`、
 * `setAuthMode`、`setStatusReady` 与全局界面交互。
 */
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
  readonly toastText: string;
  readonly toastTone: MiniAppToastTone;
  readonly confirmModal: Readonly<MiniAppConfirmModalState> | null;
  /** 密码 / TOTP 门禁输入框当前值。 */
  readonly passwordInput: string;
  /** 是否正在提交登录凭据。 */
  readonly passwordBusy: boolean;
  /** 门禁表单下方展示的错误说明（无错误时为 `null`）。 */
  readonly passwordError: string | null;

  readonly setLanguage: (language: MiniAppLanguage) => void;
  readonly cycleLanguage: () => void;
  readonly setTheme: (theme: MiniAppThemeMode) => void;
  readonly toggleTheme: () => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly toggleSidebar: () => void;
  readonly setAuthMode: (authMode: MiniAppAuthMode) => void;
  readonly setActiveTab: (tab: MiniAppTabKey) => void;
  readonly setStatusReady: (ready: boolean) => void;
  readonly showToast: (text: string, tone?: MiniAppToastTone) => void;
  readonly clearToast: () => void;
  readonly requestConfirm: (
    message: string,
    tone?: "danger" | "primary"
  ) => Promise<boolean>;
  readonly resolveConfirm: (accepted: boolean) => void;
  /** 更新门禁输入框（TOTP 模式由调用方先过滤为最多 6 位数字）。 */
  readonly setPasswordInput: (value: string) => void;
  /**
   * 展示一条自动消失的 Toast（`MINI_APP_TOAST_DURATION_MS` 后清除，重复调用重新计时）；
   * 服务端英文状态码自动按当前语言映射为对应提示文案，文本含 `[PASSWORD_REQUIRED]` 时改为按会话过期锁定控制台。
   */
  readonly notify: (
    message: string,
    tone?: MiniAppToastTone,
    metaSource?: unknown
  ) => void;
  /**
   * 锁定控制台：清除会话到期计时器与本地会话令牌，以取消结算待确认弹窗，收起侧栏，
   * 回到密码门禁并把原因同时写入门禁错误与警告 Toast。
   */
  readonly lockSession: (reason: string) => void;
  /** 门禁 `checking` 阶段：预检 SuperAdmin 签名与持久化会话，按结果进入 `denied`、`password` 或 `unlocked`。 */
  readonly runAccessPrecheck: () => Promise<void>;
  /** 校验并提交门禁输入的访问密码或 6 位 TOTP 动态码，成功后解锁并按会话到期时刻安排自动锁定。 */
  readonly submitCredential: () => Promise<void>;
  /** 清除 Toast 自动消失与会话到期两个计时器（根组件卸载或测试重置时调用）。 */
  readonly clearTimers: () => void;
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
 * Mini App 全局 Zustand 状态仓库（`App` 根组件及其门禁、外壳组件共用的唯一实例）。
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
    ): MiniAppUiStoreState => {
      let toastTimer: ReturnType<typeof setTimeout> | null = null;
      let sessionTimer: ReturnType<typeof setTimeout> | null = null;

      const clearSessionTimer = (): void => {
        if (sessionTimer !== null) {
          clearTimeout(sessionTimer);
          sessionTimer = null;
        }
      };

      const scheduleSessionExpiry = (expiresAt: number): void => {
        clearSessionTimer();
        const remainingMs: number = Math.max(1_000, expiresAt - Date.now());
        sessionTimer = setTimeout((): void => {
          get().lockSession(
            getMiniAppTranslations(get().language).sessionExpiredToast
          );
        }, remainingMs);
      };

      return {
        language: detectInitialMiniAppLanguage(),
        theme: detectInitialMiniAppTheme(),
        sidebarOpen: false,
        gateState: "checking",
        authMode: "password",
        deniedDiag: null,
        sessionExpiresAt: 0,
        activeTab: "status",
        statusReady: false,
        toastText: "",
        toastTone: "info",
        confirmModal: null,
        passwordInput: "",
        passwordBusy: false,
        passwordError: null,

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

        setAuthMode: (authMode: MiniAppAuthMode): void => {
          set({ authMode });
        },

        setActiveTab: (tab: MiniAppTabKey): void => {
          set({ activeTab: tab, sidebarOpen: false });
        },

        setStatusReady: (ready: boolean): void => {
          set({ statusReady: ready });
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

        setPasswordInput: (value: string): void => {
          set({ passwordInput: value });
        },

        notify: (
          message: string,
          tone: MiniAppToastTone = "info",
          metaSource?: unknown
        ): void => {
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
            get().language
          );
          const localized: string = t.serverNotice(
            message,
            extractServerNoticeParams(metaSource)
          );
          if (message.includes("[PASSWORD_REQUIRED]")) {
            get().lockSession(localized);
            return;
          }
          get().showToast(localized, tone);
          if (toastTimer !== null) {
            clearTimeout(toastTimer);
          }
          toastTimer = setTimeout((): void => {
            get().clearToast();
            toastTimer = null;
          }, MINI_APP_TOAST_DURATION_MS);
        },

        lockSession: (reason: string): void => {
          clearSessionTimer();
          clearMiniAppAssetToken();
          clearMiniAppSessionToken();
          const current: Readonly<MiniAppConfirmModalState> | null = get().confirmModal;
          if (current !== null) {
            current.resolve(false);
          }
          const localizedReason: string = getMiniAppTranslations(
            get().language
          ).serverNotice(reason);
          set({
            passwordInput: "",
            passwordError: localizedReason,
            sessionExpiresAt: 0,
            statusReady: false,
            sidebarOpen: false,
            confirmModal: null,
            gateState: "password",
            toastText: localizedReason,
            toastTone: "warning",
          });
        },

        runAccessPrecheck: async (): Promise<void> => {
          try {
            const result: MiniAppPrecheckResult = await precheckMiniAppAccess();
            if (!result.ok) {
              clearMiniAppAssetToken();
              clearMiniAppSessionToken();
              set({ deniedDiag: result.diagnostics, gateState: "denied" });
              return;
            }
            set({
              authMode: result.authMode ?? (result.totpEnabled === true ? "totp" : "password"),
              passwordError: null,
            });
            if (
              result.sessionValid === true &&
              typeof result.sessionExpiresAt === "number" &&
              result.sessionExpiresAt > Date.now() &&
              readMiniAppSessionToken().length > 0
            ) {
              scheduleSessionExpiry(result.sessionExpiresAt);
              set({ sessionExpiresAt: result.sessionExpiresAt, gateState: "unlocked" });
              return;
            }
            clearMiniAppAssetToken();
            clearMiniAppSessionToken();
            set({ gateState: "password" });
          } catch (error: unknown) {
            clearMiniAppAssetToken();
            clearMiniAppSessionToken();
            const message: string = errorMessage(error);
            set({ deniedDiag: buildFallbackDiagnostics(message), gateState: "denied" });
          }
        },

        submitCredential: async (): Promise<void> => {
          const { authMode, passwordInput, language }: MiniAppUiStoreState = get();
          const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
          const trimmed: string = passwordInput.trim();
          if (authMode === "totp") {
            if (!/^\d{6}$/u.test(trimmed)) {
              set({ passwordError: t.gate.totpEmptyHint });
              return;
            }
          } else if (trimmed.length === 0) {
            set({ passwordError: t.gate.passwordEmptyHint });
            return;
          }
          set({ passwordBusy: true, passwordError: null });
          try {
            const loginRes: MiniAppLoginSuccessResponse =
              await loginMiniAppWithPassword(trimmed, authMode);
            scheduleSessionExpiry(loginRes.expiresAt);
            set({
              sessionExpiresAt: loginRes.expiresAt,
              statusReady: false,
              passwordInput: "",
              gateState: "unlocked",
            });
            get().notify(t.gate.unlockedToast);
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            if (message.includes("[PASSWORD_LOCKED]")) {
              const lockedCheck: MiniAppPrecheckResult = await precheckMiniAppAccess();
              set({
                deniedDiag: lockedCheck.ok
                  ? buildFallbackDiagnostics(message.replace("[PASSWORD_LOCKED]", "").trim())
                  : lockedCheck.diagnostics,
                gateState: "denied",
              });
              return;
            }
            set({
              passwordError: t.serverNotice(
                message.replace("[PASSWORD_REQUIRED]", "").trim(),
                extractServerNoticeParams(error)
              ),
            });
          } finally {
            set({ passwordBusy: false });
          }
        },

        clearTimers: (): void => {
          if (toastTimer !== null) {
            clearTimeout(toastTimer);
            toastTimer = null;
          }
          clearSessionTimer();
        },
      };
    }
  );

/**
 * 重置 Mini App Zustand 状态仓库为默认初始状态（供单元测试使用）。
 */
export function resetMiniAppStoreForTest(): void {
  clearMiniAppAssetToken();
  useMiniAppStore.getState().clearTimers();
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
    toastText: "",
    toastTone: "info",
    confirmModal: null,
    passwordInput: "",
    passwordBusy: false,
    passwordError: null,
  });
}
