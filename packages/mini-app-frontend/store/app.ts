import { create } from "zustand";
import type { UseBoundStore, StoreApi } from "zustand";
import { classifyMiniAppAuthError } from "../api/authError";
import {
  MINI_APP_DARK_BG_COLOR,
  MINI_APP_DARK_HEADER_COLOR,
  MINI_APP_INITIAL_THEME,
  MINI_APP_LIGHT_BG_COLOR,
  MINI_APP_LIGHT_HEADER_COLOR,
  MINI_APP_THEME_MODES,
  MINI_APP_TOAST_DURATION_MS,
} from "../consts/miniApp/ui";
import {
  detectInitialMiniAppLanguage,
  getMiniAppTranslations,
} from "../i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionExpiresAt,
} from "../libs/credentials";
import { errorMessage } from "../libs/errorMessage";
import type { MiniAppAccessDiagnostics } from "../types/miniApp/auth";
import type { TelegramWebApp, TelegramWindow } from "../types/miniApp/host";
import type {
  MiniAppLanguage,
  MiniAppTabKey,
  MiniAppThemeMode,
} from "../types/miniApp/ui";
import type { MiniAppAuthMode } from "../types/miniAppTotp";
import { createAppGateActions } from "./appGateActions";

/** Mini App 门禁状态枚举。 */
export type MiniAppGateState = "checking" | "denied" | "password" | "unlocked";

/** Mini App 顶部 Toast 提示色调。 */
export type MiniAppToastTone = "info" | "warning" | "danger";

/** Mini App 确认弹窗的可选自定义按钮文案（缺省项回退至当前语言的默认确认弹窗文案）。 */
export interface MiniAppConfirmButtonLabels {
  /** 取消按钮文案（缺省回退至 `t.confirmDialog.cancelButton`）。 */
  readonly cancelLabel?: string;
  /** 确认按钮文案（缺省回退至 `t.confirmDialog.confirmButton`）。 */
  readonly confirmLabel?: string;
}

/** Mini App 自定义确认弹窗状态。 */
export interface MiniAppConfirmModalState {
  /** 确认提示正文。 */
  readonly message: string;
  /** 确认按钮色调（默认 `"danger"`）。 */
  readonly tone: "danger" | "primary";
  /** 可选自定义取消按钮文案（缺省回退至 `t.confirmDialog.cancelButton`）。 */
  readonly cancelLabel?: string;
  /** 可选自定义确认按钮文案（缺省回退至 `t.confirmDialog.confirmButton`）。 */
  readonly confirmLabel?: string;
  /** 递增的确认请求序号（驱动连续确认请求重新挂载节点播放进入动画）。 */
  readonly requestSeq: number;
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
  /** 顶栏语言选择下拉菜单当前是否已展开。 */
  readonly langMenuOpen: boolean;
  readonly sidebarOpen: boolean;
  readonly gateState: MiniAppGateState;
  readonly authMode: MiniAppAuthMode;
  readonly deniedDiag: Readonly<MiniAppAccessDiagnostics> | null;
  readonly sessionExpiresAt: number;
  readonly activeTab: MiniAppTabKey;
  readonly statusReady: boolean;
  readonly toastText: string;
  readonly toastTone: MiniAppToastTone;
  /** 递增的 Toast 展示序号（驱动连续提示重新挂载节点播放进入动画）。 */
  readonly toastSeq: number;
  readonly confirmModal: Readonly<MiniAppConfirmModalState> | null;
  /** 密码 / TOTP 门禁输入框当前值。 */
  readonly passwordInput: string;
  /** 是否正在提交登录凭据。 */
  readonly passwordBusy: boolean;
  /** 门禁表单下方展示的错误说明（无错误时为 `null`）。 */
  readonly passwordError: string | null;

  readonly setLanguage: (language: MiniAppLanguage) => void;
  readonly toggleLangMenu: () => void;
  readonly closeLangMenu: () => void;
  readonly toggleTheme: () => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly toggleSidebar: () => void;
  readonly setAuthMode: (authMode: MiniAppAuthMode) => void;
  readonly setActiveTab: (tab: MiniAppTabKey) => void;
  readonly setStatusReady: (ready: boolean) => void;
  readonly showToast: (text: string, tone?: MiniAppToastTone) => void;
  readonly clearToast: () => void;
  /**
   * 弹出自定义确认弹窗并等待用户点击确认或取消（存在未结算的前序确认请求时先按取消结算）；
   * 可选覆盖取消与确认按钮文案，未指定项回退至当前语言的 `t.confirmDialog` 默认按钮文案。
   */
  readonly requestConfirm: (
    message: string,
    tone?: "primary" | "danger",
    labels?: Readonly<MiniAppConfirmButtonLabels>
  ) => Promise<boolean>;
  readonly resolveConfirm: (accepted: boolean) => void;
  /** 更新门禁输入框（TOTP 模式由调用方先过滤为最多 6 位数字）。 */
  readonly setPasswordInput: (value: string) => void;
  /**
   * 展示一条自动消失的 Toast（`MINI_APP_TOAST_DURATION_MS` 后清除，重复调用重新计时），服务端状态码按当前语言映射为本地化文案。
   * 命中会话过期、凭据缺失或密钥吊销/加密载荷失效错误（含带前缀、裸状态码或 `metaSource` 中携带的错误码）时改为锁定控制台并跳转回登录门禁；
   * 命中 `PASSWORD_LOCKED`、`EXPIRED_AUTH_DATE` 等一层门禁拒绝错误时清除本地会话并回到 `checking` 重新预检进入拦截页。
   * 若 `metaSource` 携带的发包会话令牌已被本地更新一代活跃令牌取代，则会话重认证与依赖会话延展窗口的 `EXPIRED_AUTH_DATE` 不触发锁定或清除新会话（无条件一层拒绝仍立即生效）。
   */
  readonly notify: (
    message: string,
    tone?: MiniAppToastTone,
    metaSource?: unknown
  ) => void;
  /**
   * 锁定控制台：清除会话到期计时器与本地会话令牌，按取消结算待确认弹窗，收起侧栏与语言菜单，
   * 退回登录门禁（`gateState = "password"`，按当前 `authMode` 展示密码或 TOTP 表单），并将非空原因写入门禁错误与警告 Toast。
   */
  readonly lockSession: (reason: string) => void;
  /**
   * 手动锁定（顶栏「锁定」按钮）：异步通知服务端吊销当前会话令牌（忽略网络失败），
   * 随后调用 `lockSession` 清除本地凭据并退回登录门禁。会话自然到期或服务端判定失效时仅走 `lockSession`。
   */
  readonly logout: (reason: string) => void;
  /**
   * 门禁 `checking` 阶段：预检 SuperAdmin 签名与持久化会话，按结果进入 `denied`、`password` 或 `unlocked`。
   * 预检有响应时本地令牌的保留与清除由 `precheckMiniAppAccess` 统一负责；请求本身抛错时在此清除本地凭据。
   */
  readonly runAccessPrecheck: () => Promise<void>;
  /** 校验并提交门禁输入的访问密码或 6 位 TOTP 动态码，成功后解锁并按会话到期时刻安排自动锁定。 */
  readonly submitCredential: () => Promise<void>;
  /** 清除 Toast 自动消失与会话到期两个计时器（根组件卸载或测试重置时调用）。 */
  readonly clearTimers: () => void;
}

/**
 * 将当前主题模式同步至根节点 `data-theme` 属性及 Telegram WebApp 宿主顶栏与页面背景色；
 * 单项宿主色彩接口抛错时在各自调用边界吞掉异常，不影响本地主题属性与另一项宿主色彩同步。
 *
 * @param theme 目标主题模式
 */
export function applyMiniAppThemeToDocument(theme: MiniAppThemeMode): void {
  const normalizedTheme: MiniAppThemeMode = MINI_APP_THEME_MODES.includes(theme)
    ? theme
    : MINI_APP_INITIAL_THEME;
  const tgWindow: TelegramWindow = globalThis;
  const docEl: NonNullable<TelegramWindow["document"]>["documentElement"] =
    tgWindow.document?.documentElement;
  docEl?.setAttribute?.("data-theme", normalizedTheme);
  const webApp: Readonly<TelegramWebApp> | undefined = tgWindow.Telegram?.WebApp;
  const bgHex: string =
    normalizedTheme === "light" ? MINI_APP_LIGHT_BG_COLOR : MINI_APP_DARK_BG_COLOR;
  const headerHex: string =
    normalizedTheme === "light"
      ? MINI_APP_LIGHT_HEADER_COLOR
      : MINI_APP_DARK_HEADER_COLOR;
  try {
    webApp?.setHeaderColor?.(headerHex);
  } catch (_error: unknown) {
    // 宿主顶栏色同步失败时静默忽略。
  }
  try {
    webApp?.setBackgroundColor?.(bgHex);
  } catch (_error: unknown) {
    // 宿主背景色同步失败时静默忽略。
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
      get: () => MiniAppUiStoreState,
      store: StoreApi<MiniAppUiStoreState>
    ): MiniAppUiStoreState => {
      store.getInitialState = get;
      let toastTimer: ReturnType<typeof setTimeout> | null = null;
      let sessionTimer: ReturnType<typeof setTimeout> | null = null;
      let confirmRequestSeq: number = 0;

      const clearToastTimer = (): void => {
        if (toastTimer !== null) {
          clearTimeout(toastTimer);
          toastTimer = null;
        }
      };

      const scheduleToastDismiss = (): void => {
        clearToastTimer();
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          toastTimer = null;
          set({ toastText: "", toastTone: "info" });
        }, MINI_APP_TOAST_DURATION_MS);
        timer?.unref?.();
        toastTimer = timer;
      };

      const clearSessionTimer = (): void => {
        if (sessionTimer !== null) {
          clearTimeout(sessionTimer);
          sessionTimer = null;
        }
      };

      const clearActiveSessionState = (): void => {
        clearSessionTimer();
        clearMiniAppSessionToken();
        get().resolveConfirm(false);
      };

      const scheduleSessionExpiry = (expiresAt: number): void => {
        clearSessionTimer();
        const remainingMs: number = Math.max(1_000, expiresAt - Date.now());
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          const latestExpiresAt: number = readMiniAppSessionExpiresAt();
          if (latestExpiresAt > Date.now() && latestExpiresAt > expiresAt) {
            set({ sessionExpiresAt: latestExpiresAt });
            scheduleSessionExpiry(latestExpiresAt);
            return;
          }
          get().lockSession(
            getMiniAppTranslations(get().language).sessionExpiredToast
          );
        }, remainingMs);
        timer?.unref?.();
        sessionTimer = timer;
      };

      return {
        language: detectInitialMiniAppLanguage(),
        theme: MINI_APP_INITIAL_THEME,
        langMenuOpen: false,
        sidebarOpen: false,
        gateState: "checking",
        authMode: "password",
        deniedDiag: null,
        sessionExpiresAt: 0,
        activeTab: "status",
        statusReady: false,
        toastText: "",
        toastTone: "info",
        toastSeq: 0,
        confirmModal: null,
        passwordInput: "",
        passwordBusy: false,
        passwordError: null,

        setLanguage: (language: MiniAppLanguage): void => {
          set({ language, langMenuOpen: false });
        },

        toggleLangMenu: (): void => {
          set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
            langMenuOpen: !state.langMenuOpen,
          }));
        },

        closeLangMenu: (): void => {
          set({ langMenuOpen: false });
        },

        toggleTheme: (): void => {
          set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => {
            const nextTheme: MiniAppThemeMode = state.theme === "dark" ? "light" : "dark";
            applyMiniAppThemeToDocument(nextTheme);
            return { theme: nextTheme };
          });
        },

        setSidebarOpen: (open: boolean): void => {
          set({ sidebarOpen: open, langMenuOpen: false });
        },

        toggleSidebar: (): void => {
          set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
            sidebarOpen: !state.sidebarOpen,
            langMenuOpen: false,
          }));
        },

        setAuthMode: (authMode: MiniAppAuthMode): void => {
          set({ authMode });
        },

        setActiveTab: (tab: MiniAppTabKey): void => {
          set({ activeTab: tab, sidebarOpen: false, langMenuOpen: false });
        },

        setStatusReady: (ready: boolean): void => {
          set({ statusReady: ready });
        },

        showToast: (text: string, tone: MiniAppToastTone = "info"): void => {
          set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
            toastText: text,
            toastTone: tone,
            toastSeq: text.length > 0 ? state.toastSeq + 1 : state.toastSeq,
          }));
        },

        clearToast: (): void => {
          clearToastTimer();
          set({ toastText: "", toastTone: "info" });
        },

        requestConfirm: (
          message: string,
          tone: "primary" | "danger" = "danger",
          labels?: Readonly<MiniAppConfirmButtonLabels>
        ): Promise<boolean> => {
          const prev: Readonly<MiniAppConfirmModalState> | null = get().confirmModal;
          if (prev !== null) {
            prev.resolve(false);
          }
          confirmRequestSeq += 1;
          const requestSeq: number = confirmRequestSeq;
          const cancelLabel: string | undefined = labels?.cancelLabel;
          const confirmLabel: string | undefined = labels?.confirmLabel;
          return new Promise<boolean>((resolve: (accepted: boolean) => void): void => {
            set({
              confirmModal: {
                message,
                tone,
                ...(cancelLabel !== undefined ? { cancelLabel } : {}),
                ...(confirmLabel !== undefined ? { confirmLabel } : {}),
                requestSeq,
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

        ...createAppGateActions({
          set,
          get,
          clearToastTimer,
          scheduleToastDismiss,
          clearSessionTimer,
          scheduleSessionExpiry,
          clearActiveSessionState,
        }),
      };
    }
  );

/**
 * 重置 Mini App Zustand 状态仓库为默认初始状态（供单元测试使用）。
 */
export function resetMiniAppStoreForTest(): void {
  useMiniAppStore.getState().clearTimers();
  const prev: Readonly<MiniAppConfirmModalState> | null =
    useMiniAppStore.getState().confirmModal;
  if (prev !== null) {
    prev.resolve(false);
  }
  useMiniAppStore.setState({
    language: detectInitialMiniAppLanguage(),
    theme: MINI_APP_INITIAL_THEME,
    langMenuOpen: false,
    sidebarOpen: false,
    gateState: "checking",
    authMode: "password",
    deniedDiag: null,
    sessionExpiresAt: 0,
    activeTab: "status",
    statusReady: false,
    toastText: "",
    toastTone: "info",
    toastSeq: 0,
    confirmModal: null,
    passwordInput: "",
    passwordBusy: false,
    passwordError: null,
  });
}

/**
 * 检查捕获到的异常是否属于会话过期、密钥吊销或门禁拒绝错误；
 * 命中时立即经根仓库 `notify` 触发重定向与凭据清理并返回 `true`，其余瞬时或业务异常静默忽略并返回 `false`。
 *
 * @param error 捕获到的异常对象
 * @returns 命中并已交由根仓库重定向时返回 `true`，否则返回 `false`
 */
export function notifyMiniAppIfAuthError(error: unknown): boolean {
  const rawMessage: string = errorMessage(error);
  if (classifyMiniAppAuthError(rawMessage, error) !== null) {
    useMiniAppStore.getState().notify(rawMessage, "info", error);
    return true;
  }
  return false;
}
