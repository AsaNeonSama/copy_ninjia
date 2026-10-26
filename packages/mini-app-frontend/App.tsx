import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_LANGUAGES,
  MINI_APP_TAB_KEYS,
  MINI_APP_TOAST_DURATION_MS,
} from "./consts/miniApp";
import type {
  MiniAppAccessDiagnostics,
  MiniAppLanguage,
  MiniAppLoginSuccessResponse,
  MiniAppPrecheckResult,
  MiniAppStatusView,
  MiniAppTabKey,
  MiniAppThemeMode,
  TelegramWebApp,
  TelegramWindow,
} from "./types/miniApp";
import type { MiniAppAuthMode } from "./types/miniAppTotp";
import {
  AlertSvgIcon,
  CloseSvgIcon,
  GlobeSvgIcon,
  LockSvgIcon,
  MenuSvgIcon,
  MoonSvgIcon,
  StatusSvgIcon,
  SunSvgIcon,
  TabSvgIcon,
} from "./miniAppResoures";
import {
  clearMiniAppSessionToken,
  getTelegramWebApp,
  loginMiniAppWithPassword,
  precheckMiniAppAccess,
  readMiniAppSessionToken,
} from "./api";
import { ChatsTab } from "./components/ChatsTab";
import { GalleryTab } from "./components/GalleryTab";
import { IdentitiesTab } from "./components/IdentitiesTab";
import { StatusTab } from "./components/StatusTab";
import { TotpManagerCard } from "./components/TotpManagerCard";
import { waitMinimumLoadingDuration } from "./formatters";
import {
  detectBrowserDefaultLanguage,
  getMiniAppTranslations,
} from "./i18n";
import type { MiniAppTranslations } from "./i18n";
import {
  applyMiniAppThemeToDocument,
  useMiniAppStore,
} from "./store";
import type {
  MiniAppConfirmModalState,
  MiniAppGateState,
  MiniAppToastTone,
  MiniAppUiStoreState,
} from "./store";

/**
 * 构造网络异常时的兜底访问诊断对象。
 *
 * @param errorText 错误说明文本
 * @returns 兜底访问诊断对象
 */
function buildFallbackDiagnostics(
  errorText: string
): Readonly<MiniAppAccessDiagnostics> {
  const tgWindow: TelegramWindow = globalThis;
  const rawHost: string | undefined = tgWindow.location?.host;
  const host: string =
    rawHost !== undefined && rawHost.length > 0 ? rawHost : "localhost";
  return {
    requestId: "0000000000000000",
    timestamp: `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
    clientIp: "127.0.0.1",
    host,
    path: "/api/auth/precheck",
    status: 403,
    code: "ACCESS_DENIED",
    error: errorText,
  };
}

/**
 * Copy Ninja Mini App 根 React 应用组件（基于 Zustand 管理全局状态、三语言切换、亮暗主题与折叠侧边栏菜单）。
 *
 * @returns React 根视图
 */
export function App(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const theme: MiniAppThemeMode = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppThemeMode => state.theme
  );
  const sidebarOpen: boolean = useMiniAppStore(
    (state: MiniAppUiStoreState): boolean => state.sidebarOpen
  );
  const gateState: MiniAppGateState = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppGateState => state.gateState
  );
  const authMode: MiniAppAuthMode = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppAuthMode => state.authMode
  );
  const deniedDiag: Readonly<MiniAppAccessDiagnostics> | null = useMiniAppStore(
    (state: MiniAppUiStoreState): Readonly<MiniAppAccessDiagnostics> | null =>
      state.deniedDiag
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
  const initialStatus: Readonly<MiniAppStatusView> | null = useMiniAppStore(
    (state: MiniAppUiStoreState): Readonly<MiniAppStatusView> | null =>
      state.initialStatus
  );
  const toastText: string = useMiniAppStore(
    (state: MiniAppUiStoreState): string => state.toastText
  );
  const toastTone: MiniAppToastTone = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppToastTone => state.toastTone
  );
  const confirmModal: Readonly<MiniAppConfirmModalState> | null = useMiniAppStore(
    (state: MiniAppUiStoreState): Readonly<MiniAppConfirmModalState> | null =>
      state.confirmModal
  );

  const setLanguage: (lang: MiniAppLanguage) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((lang: MiniAppLanguage) => void) => state.setLanguage
  );
  const toggleTheme: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleTheme
  );
  const setSidebarOpen: (open: boolean) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((open: boolean) => void) => state.setSidebarOpen
  );
  const toggleSidebar: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.toggleSidebar
  );
  const setGateState: (next: MiniAppGateState) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((next: MiniAppGateState) => void) => state.setGateState
  );
  const setAuthMode: (next: MiniAppAuthMode) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((next: MiniAppAuthMode) => void) => state.setAuthMode
  );
  const setDeniedDiag: (diag: Readonly<MiniAppAccessDiagnostics> | null) => void =
    useMiniAppStore(
      (state: MiniAppUiStoreState): ((diag: Readonly<MiniAppAccessDiagnostics> | null) => void) =>
        state.setDeniedDiag
    );
  const setSessionExpiresAt: (expiresAt: number) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((expiresAt: number) => void) => state.setSessionExpiresAt
  );
  const setActiveTab: (tab: MiniAppTabKey) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((tab: MiniAppTabKey) => void) => state.setActiveTab
  );
  const setStatusReady: (ready: boolean) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((ready: boolean) => void) => state.setStatusReady
  );
  const setInitialStatus: (status: Readonly<MiniAppStatusView> | null) => void =
    useMiniAppStore(
      (state: MiniAppUiStoreState): ((status: Readonly<MiniAppStatusView> | null) => void) =>
        state.setInitialStatus
    );
  const setStoreToast: (text: string, tone?: MiniAppToastTone) => void =
    useMiniAppStore(
      (state: MiniAppUiStoreState): ((text: string, tone?: MiniAppToastTone) => void) =>
        state.showToast
    );
  const clearStoreToast: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.clearToast
  );
  const resolveConfirm: (accepted: boolean) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((accepted: boolean) => void) =>
      state.resolveConfirm
  );
  const lockStoreSession: (noticeText?: string) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((noticeText?: string) => void) => state.lockSession
  );

  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [passwordInput, setPasswordInput]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");
  const [passwordBusy, setPasswordBusy]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [passwordError, setPasswordError]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);

  const toastTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null> =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null> =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const unsafeUserId: number | undefined = webApp?.initDataUnsafe?.user?.id;

  useEffect((): void => {
    applyMiniAppThemeToDocument(theme);
  }, [theme]);

  const lockForExpiredSession: (reason: string) => void = useCallback(
    (reason: string): void => {
      if (sessionTimerRef.current !== null) {
        clearTimeout(sessionTimerRef.current);
        sessionTimerRef.current = null;
      }
      setPasswordInput("");
      setPasswordError(reason);
      lockStoreSession(reason);
    },
    [lockStoreSession]
  );

  const showToast: (message: string) => void = useCallback(
    (message: string): void => {
      if (message.includes("[PASSWORD_REQUIRED]")) {
        lockForExpiredSession(message.replace("[PASSWORD_REQUIRED]", "").trim());
        return;
      }
      setStoreToast(message, "info");
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = setTimeout((): void => {
        clearStoreToast();
        toastTimerRef.current = null;
      }, MINI_APP_TOAST_DURATION_MS);
    },
    [clearStoreToast, lockForExpiredSession, setStoreToast]
  );

  useEffect((): (() => void) => {
    return (): void => {
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
      if (sessionTimerRef.current !== null) {
        clearTimeout(sessionTimerRef.current);
      }
    };
  }, []);

  useEffect((): void => {
    if (gateState !== "checking") return;
    const startedAt: number = Date.now();
    void (async (): Promise<void> => {
      try {
        const result: MiniAppPrecheckResult = await precheckMiniAppAccess();
        await waitMinimumLoadingDuration(startedAt);
        if (!result.ok) {
          clearMiniAppSessionToken();
          setDeniedDiag(result.diagnostics);
          setGateState("denied");
          return;
        }
        setAuthMode(
          result.authMode ?? (result.totpEnabled === true ? "totp" : "password")
        );
        setPasswordError(null);
        if (
          result.sessionValid === true &&
          typeof result.sessionExpiresAt === "number" &&
          result.sessionExpiresAt > Date.now() &&
          readMiniAppSessionToken().length > 0
        ) {
          if (sessionTimerRef.current !== null) {
            clearTimeout(sessionTimerRef.current);
          }
          const remainingMs: number = Math.max(
            1_000,
            result.sessionExpiresAt - Date.now()
          );
          sessionTimerRef.current = setTimeout((): void => {
            lockForExpiredSession(
              getMiniAppTranslations(useMiniAppStore.getState().language)
                .sessionExpiredToast
            );
          }, remainingMs);
          setSessionExpiresAt(result.sessionExpiresAt);
          setGateState("unlocked");
          return;
        }
        clearMiniAppSessionToken();
        setGateState("password");
      } catch (error: unknown) {
        await waitMinimumLoadingDuration(startedAt);
        clearMiniAppSessionToken();
        const message: string =
          error instanceof Error ? error.message : String(error);
        setDeniedDiag(buildFallbackDiagnostics(message));
        setGateState("denied");
      }
    })();
  }, [
    gateState,
    lockForExpiredSession,
    setAuthMode,
    setDeniedDiag,
    setGateState,
    setSessionExpiresAt,
  ]);

  const handlePasswordSubmit: (
    event: React.SyntheticEvent<HTMLFormElement>
  ) => void = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const trimmed: string = passwordInput.trim();
      if (authMode === "totp") {
        if (!/^\d{6}$/u.test(trimmed)) {
          setPasswordError(t.gate.totpEmptyHint);
          return;
        }
      } else if (trimmed.length === 0) {
        setPasswordError(t.gate.passwordEmptyHint);
        return;
      }
      setPasswordBusy(true);
      setPasswordError(null);
      void (async (): Promise<void> => {
        try {
          const loginRes: MiniAppLoginSuccessResponse =
            await loginMiniAppWithPassword(trimmed, authMode);
          if (sessionTimerRef.current !== null) {
            clearTimeout(sessionTimerRef.current);
          }
          const remainingMs: number = Math.max(
            1_000,
            loginRes.expiresAt - Date.now()
          );
          sessionTimerRef.current = setTimeout((): void => {
            lockForExpiredSession(t.sessionExpiredToast);
          }, remainingMs);
          setSessionExpiresAt(loginRes.expiresAt);
          setInitialStatus(null);
          setStatusReady(false);
          setPasswordInput("");
          setGateState("unlocked");
          showToast(t.gate.unlockedToast);
        } catch (error: unknown) {
          const message: string =
            error instanceof Error ? error.message : String(error);
          if (message.includes("[PASSWORD_LOCKED]")) {
            const lockedCheck: MiniAppPrecheckResult =
              await precheckMiniAppAccess();
            setDeniedDiag(
              lockedCheck.ok
                ? buildFallbackDiagnostics(
                  message.replace("[PASSWORD_LOCKED]", "").trim()
                )
                : lockedCheck.diagnostics
            );
            setGateState("denied");
            return;
          }
          setPasswordError(message.replace("[PASSWORD_REQUIRED]", "").trim());
        } finally {
          setPasswordBusy(false);
        }
      })();
    },
    [
      authMode,
      lockForExpiredSession,
      passwordInput,
      setDeniedDiag,
      setGateState,
      setInitialStatus,
      setSessionExpiresAt,
      setStatusReady,
      showToast,
      t.gate.passwordEmptyHint,
      t.gate.totpEmptyHint,
      t.gate.unlockedToast,
      t.sessionExpiredToast,
    ]
  );

  const handleStatusLoaded: (_status: MiniAppStatusView) => void = useCallback(
    (_status: MiniAppStatusView): void => {
      setStatusReady(true);
    },
    [setStatusReady]
  );

  const renderPrefsBar = (): React.JSX.Element => (
    <div className="prefs-bar">
      <div className="lang-pill-group" role="group" aria-label="Language">
        <GlobeSvgIcon size={15} className="lang-globe-icon" />
        {MINI_APP_LANGUAGES.map((lang: MiniAppLanguage): React.JSX.Element => {
          const label: string = getMiniAppTranslations(lang).languageLabel;
          return (
            <button
              key={lang}
              type="button"
              className={`lang-pill-btn ${language === lang ? "active" : ""}`}
              onClick={(): void => {
                setLanguage(lang);
              }}
            >
              {label}
            </button>
          );
        })}
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

  const renderToast = (): React.JSX.Element | null => {
    if (toastText.length === 0) return null;
    const isWarnOrDanger: boolean =
      toastTone === "warning" || toastTone === "danger";
    return (
      <div className={`toast show toast-${toastTone}`} role="status">
        <span className="toast-badge" aria-hidden="true">
          {isWarnOrDanger
            ? <AlertSvgIcon size={14} />
            : <StatusSvgIcon size={14} />}
        </span>
        <span className="toast-text">{toastText}</span>
        <button
          type="button"
          className="toast-close"
          onClick={clearStoreToast}
          aria-label="Close"
        >
          <CloseSvgIcon size={14} />
        </button>
      </div>
    );
  };

  const renderConfirmModal = (): React.JSX.Element | null => {
    if (confirmModal === null) return null;
    const isDanger: boolean = confirmModal.tone === "danger";
    return (
      <div
        className="confirm-backdrop"
        role="dialog"
        aria-modal="true"
        onClick={(): void => {
          resolveConfirm(false);
        }}
      >
        <div
          className="confirm-dialog animate-fade-in"
          onClick={(event: React.SyntheticEvent<HTMLDivElement>): void => {
            event.stopPropagation();
          }}
        >
          <div className="confirm-header">
            <span className="toolbar-hint">
              <span
                className={`toolbar-icon-badge ${isDanger ? "danger-badge" : ""}`}
              >
                <AlertSvgIcon size={16} />
              </span>
              <span>{t.confirmDialog.title}</span>
            </span>
            <button
              type="button"
              className="btn icon-btn"
              onClick={(): void => {
                resolveConfirm(false);
              }}
              aria-label={t.confirmDialog.cancelButton}
            >
              <CloseSvgIcon size={14} />
            </button>
          </div>
          <div className="confirm-body">{confirmModal.message}</div>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn"
              onClick={(): void => {
                resolveConfirm(false);
              }}
            >
              {t.confirmDialog.cancelButton}
            </button>
            <button
              type="button"
              className={`btn ${isDanger ? "danger" : "primary"}`}
              onClick={(): void => {
                resolveConfirm(true);
              }}
            >
              {t.confirmDialog.confirmButton}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (gateState === "checking") {
    const checkingLang: MiniAppLanguage = detectBrowserDefaultLanguage();
    const ct: Readonly<MiniAppTranslations> =
      getMiniAppTranslations(checkingLang);
    return (
      <div className="auth-gate-wrap animate-fade-in">
        <div className="gate-top-prefs">{renderPrefsBar()}</div>
        <div
          className="card auth-gate-card auth-gate-skeleton"
          aria-busy="true"
          aria-label={ct.gate.checkingText}
        >
          <div className="card-title">
            <span className="toolbar-hint" style={{ flex: 1, minWidth: 0 }}>
              <span className="skeleton-line skeleton-icon-badge" />
              <span className="skeleton-line skeleton-title-bar" />
            </span>
            <span className="skeleton-line skeleton-badge-pill" />
          </div>
          <div className="skeleton-auth-desc">
            <div className="skeleton-line" style={{ width: "92%" }} />
            <div className="skeleton-line" style={{ width: "66%" }} />
          </div>
          <div className="auth-gate-form">
            <div className="skeleton-line skeleton-auth-input" />
            <div className="skeleton-line skeleton-auth-btn" />
          </div>
        </div>
      </div>
    );
  }

  if (gateState === "denied") {
    const deniedLang: MiniAppLanguage = detectBrowserDefaultLanguage();
    const dt: Readonly<MiniAppTranslations> =
      getMiniAppTranslations(deniedLang);
    const diag: Readonly<MiniAppAccessDiagnostics> =
      deniedDiag ?? buildFallbackDiagnostics(dt.gate.deniedDescription);
    return (
      <div className="cf-error-page">
        <div className="cf-error-container">
          <div className="cf-header">
            <div className="cf-title-row">
              <span className="cf-main-title">{dt.gate.deniedTitle}</span>
              <span className="cf-code-pill">
                HTTP {diag.status} · {diag.code}
              </span>
            </div>
            <p className="cf-subtitle">{dt.gate.deniedDescription}</p>
            <div className="cf-timestamp">{diag.timestamp}</div>
          </div>

          <div className="cf-status-band">
            <div className="cf-status-inner">
              <div className="cf-node">
                <div className="cf-node-icon ok">✓</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">{dt.gate.deniedNodeClientSub}</div>
                  <div className="cf-node-title">
                    {dt.gate.deniedNodeClientTitle}
                  </div>
                  <div className="cf-node-state ok">
                    {dt.gate.deniedNodeClientState}
                  </div>
                </div>
              </div>

              <div className="cf-node">
                <div className="cf-node-icon err">✕</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">
                    {dt.gate.deniedNodeGatewaySub}
                  </div>
                  <div className="cf-node-title">
                    {dt.gate.deniedNodeGatewayTitle}
                  </div>
                  <div className="cf-node-state err">
                    {dt.gate.deniedNodeGatewayState(diag.status)}
                  </div>
                </div>
              </div>

              <div className="cf-node">
                <div className="cf-node-icon ok">✓</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">{dt.gate.deniedNodeOriginSub}</div>
                  <div className="cf-node-title">{diag.host}</div>
                  <div className="cf-node-state ok">
                    {dt.gate.deniedNodeOriginState}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="cf-details-grid">
            <div className="cf-detail-col">
              <h2>{dt.gate.deniedWhatHappenedTitle}</h2>
              <p>{dt.gate.deniedWhatHappenedDesc}</p>
              <div className="cf-reason-box">
                <strong>{dt.gate.deniedPolicyDetailLabel(diag.code)}:</strong>{" "}
                {dt.gate.deniedPolicyReason(diag.code, diag.error)}
              </div>
            </div>
            <div className="cf-detail-col">
              <h2>{dt.gate.deniedWhatCanIDoTitle}</h2>
              <p>{dt.gate.deniedWhatCanIDoDesc}</p>
            </div>
          </div>

          <div className="cf-footer">
            <span>
              Request ID: <strong>{diag.requestId}</strong>
            </span>
            <span className="cf-sep">•</span>
            <span>
              Client IP: <strong>{diag.clientIp}</strong>
            </span>
            <span className="cf-sep">•</span>
            <span>
              Host: <strong>{diag.host}</strong>
            </span>
            <span className="cf-sep">•</span>
            <span>
              Path: <strong>{diag.path}</strong>
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (gateState === "password") {
    const isTotpGate: boolean = authMode === "totp";
    return (
      <div className="auth-gate-wrap animate-fade-in">
        <div className="gate-top-prefs">{renderPrefsBar()}</div>
        <div className="card auth-gate-card">
          <div className="card-title">
            <span className="toolbar-hint">
              <span className="toolbar-icon-badge">
                <LockSvgIcon size={15} />
              </span>
              <span>{isTotpGate ? t.gate.totpTitle : t.gate.passwordTitle}</span>
            </span>
            <span className="badge ok">
              {unsafeUserId !== undefined
                ? `SuperAdmin #${unsafeUserId}`
                : isTotpGate
                  ? t.gate.totpBadge
                  : t.gate.passwordBadge}
            </span>
          </div>
          <p className="auth-gate-desc">
            {isTotpGate ? t.gate.totpSubtitle : t.gate.passwordSubtitle}
          </p>
          <form onSubmit={handlePasswordSubmit} className="auth-gate-form">
            <input
              type={isTotpGate ? "text" : "password"}
              inputMode={isTotpGate ? "numeric" : undefined}
              maxLength={isTotpGate ? 6 : undefined}
              className="auth-gate-input"
              placeholder={
                isTotpGate ? t.gate.totpPlaceholder : t.gate.passwordPlaceholder
              }
              autoComplete={isTotpGate ? "one-time-code" : "current-password"}
              value={passwordInput}
              disabled={passwordBusy}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                const rawVal: string = (
                  event.currentTarget as unknown as { readonly value: string }
                ).value;
                setPasswordInput(
                  isTotpGate ? rawVal.replace(/\D+/gu, "").slice(0, 6) : rawVal
                );
              }}
            />
            {passwordError !== null
              ? <div className="auth-gate-error">{passwordError}</div>
              : null}
            <button
              type="submit"
              className="btn primary auth-gate-submit"
              disabled={passwordBusy || passwordInput.trim().length === 0}
            >
              {passwordBusy
                ? t.gate.passwordSubmitting
                : isTotpGate
                  ? t.gate.totpSubmitButton
                  : t.gate.passwordSubmitButton}
            </button>
          </form>
        </div>
        {renderToast()}
      </div>
    );
  }

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
          {renderPrefsBar()}
          {sessionExpiresAt > 0
            ? (
              <button
                type="button"
                className="btn icon-btn"
                onClick={(): void => {
                  lockForExpiredSession(t.lockSessionToast);
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
        {activeTab === "status"
          ? (
            <StatusTab
              initialStatus={initialStatus}
              onStatusLoaded={handleStatusLoaded}
              onToast={showToast}
            />
          )
          : null}

        {activeTab === "chats" ? <ChatsTab onToast={showToast} /> : null}

        {activeTab === "identities"
          ? <IdentitiesTab onToast={showToast} />
          : null}

        {activeTab === "gallery" ? <GalleryTab onToast={showToast} /> : null}

        {activeTab === "totp" ? <TotpManagerCard onToast={showToast} /> : null}
      </main>

      {renderConfirmModal()}
      {renderToast()}
    </div>
  );
}
