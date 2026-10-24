import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  MINI_APP_HTML_TITLE,
  MINI_APP_PASSWORD_MAX_ATTEMPTS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_TOAST_DURATION_MS,
} from "../../consts/miniApp";
import type {
  MiniAppAccessDiagnostics,
  MiniAppLoginSuccessResponse,
  MiniAppPrecheckResult,
  MiniAppStatusView,
  MiniAppTabKey,
  TelegramWebApp,
  TelegramWindow,
} from "../../types/miniApp";
import {
  clearMiniAppSessionToken,
  fetchMiniAppStatus,
  getTelegramWebApp,
  loginMiniAppWithPassword,
  precheckMiniAppAccess,
} from "./api";
import { ChatsTab } from "./components/ChatsTab";
import { GalleryTab } from "./components/GalleryTab";
import { IdentitiesTab } from "./components/IdentitiesTab";
import { StatusTab } from "./components/StatusTab";

/** 前端门禁状态（签名预检 -> 密码解锁 -> 已认证控制台；预检失败进入 403 拒绝页）。 */
type MiniAppGateState = "checking" | "password" | "authenticated" | "denied";

/** 构造网络异常时的兜底访问诊断对象。 */
function buildFallbackDiagnostics(errorText: string): Readonly<MiniAppAccessDiagnostics> {
  const tgWindow: TelegramWindow = globalThis;
  const rawHost: string | undefined = tgWindow.location?.host;
  const host: string = rawHost !== undefined && rawHost.length > 0 ? rawHost : "localhost";
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
 * Copy Ninja Mini App 根 React 应用组件（含双层门禁：Telegram 签名核验 + 首屏密码认证，90 分钟自动过期）。
 *
 * @returns React 根视图
 */
export function App(): React.JSX.Element {
  const [gateState, setGateState]: [
    MiniAppGateState,
    React.Dispatch<React.SetStateAction<MiniAppGateState>>
  ] = useState<MiniAppGateState>("checking");
  const [deniedDiag, setDeniedDiag]: [
    Readonly<MiniAppAccessDiagnostics> | null,
    React.Dispatch<React.SetStateAction<Readonly<MiniAppAccessDiagnostics> | null>>
  ] = useState<Readonly<MiniAppAccessDiagnostics> | null>(null);
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
  const [sessionExpiresAt, setSessionExpiresAt]: [
    number | null,
    React.Dispatch<React.SetStateAction<number | null>>
  ] = useState<number | null>(null);
  const [initialStatus, setInitialStatus]: [
    MiniAppStatusView | null,
    React.Dispatch<React.SetStateAction<MiniAppStatusView | null>>
  ] = useState<MiniAppStatusView | null>(null);
  const [activeTab, setActiveTab]: [
    MiniAppTabKey,
    React.Dispatch<React.SetStateAction<MiniAppTabKey>>
  ] = useState<MiniAppTabKey>("status");
  const [statusReady, setStatusReady]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [toastText, setToastText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const toastTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null> =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null> =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const unsafeUserId: number | undefined = webApp?.initDataUnsafe?.user?.id;

  const lockForExpiredSession: (reason: string) => void = useCallback(
    (reason: string): void => {
      if (sessionTimerRef.current !== null) {
        clearTimeout(sessionTimerRef.current);
        sessionTimerRef.current = null;
      }
      clearMiniAppSessionToken();
      setSessionExpiresAt(null);
      setInitialStatus(null);
      setStatusReady(false);
      setPasswordInput("");
      setPasswordError(reason);
      setGateState("password");
    },
    []
  );

  const showToast: (message: string) => void = useCallback(
    (message: string): void => {
      if (message.includes("[PASSWORD_REQUIRED]")) {
        lockForExpiredSession(message.replace("[PASSWORD_REQUIRED]", "").trim());
        return;
      }
      setToastText(message);
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = setTimeout((): void => {
        setToastText(null);
        toastTimerRef.current = null;
      }, MINI_APP_TOAST_DURATION_MS);
    },
    [lockForExpiredSession]
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
    void (async (): Promise<void> => {
      try {
        clearMiniAppSessionToken();
        const result: MiniAppPrecheckResult = await precheckMiniAppAccess();
        if (!result.ok) {
          setDeniedDiag(result.diagnostics);
          setGateState("denied");
          return;
        }
        setPasswordError(null);
        setGateState("password");
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        setDeniedDiag(buildFallbackDiagnostics(message));
        setGateState("denied");
      }
    })();
  }, [gateState]);

  const handlePasswordSubmit: (event: React.SyntheticEvent<HTMLFormElement>) => void =
    useCallback(
      (event: React.SyntheticEvent<HTMLFormElement>): void => {
        event.preventDefault();
        const trimmed: string = passwordInput.trim();
        if (trimmed.length === 0) {
          setPasswordError("请输入访问密码。");
          return;
        }
        setPasswordBusy(true);
        setPasswordError(null);
        void (async (): Promise<void> => {
          try {
            const loginRes: MiniAppLoginSuccessResponse =
              await loginMiniAppWithPassword(trimmed);
            const status: MiniAppStatusView = await fetchMiniAppStatus();
            if (sessionTimerRef.current !== null) {
              clearTimeout(sessionTimerRef.current);
            }
            const remainingMs: number = Math.max(
              1_000,
              loginRes.expiresAt - Date.now()
            );
            sessionTimerRef.current = setTimeout((): void => {
              lockForExpiredSession("访问认证已满 90 分钟过期，请重新输入访问密码。");
            }, remainingMs);
            setSessionExpiresAt(loginRes.expiresAt);
            setInitialStatus(status);
            setStatusReady(true);
            setPasswordInput("");
            setGateState("authenticated");
          } catch (error: unknown) {
            const message: string =
              error instanceof Error ? error.message : String(error);
            if (message.includes("[PASSWORD_LOCKED]")) {
              const lockedCheck: MiniAppPrecheckResult = await precheckMiniAppAccess();
              setDeniedDiag(
                lockedCheck.ok
                  ? buildFallbackDiagnostics(message.replace("[PASSWORD_LOCKED]", "").trim())
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
      [lockForExpiredSession, passwordInput]
    );

  const handleStatusLoaded: (_status: MiniAppStatusView) => void = useCallback(
    (_status: MiniAppStatusView): void => {
      setStatusReady(true);
    },
    []
  );

  if (gateState === "checking") {
    return (
      <div className="card" style={{ marginTop: "24px" }}>
        <div className="empty">正在验证 SuperAdmin Telegram 签名凭据…</div>
      </div>
    );
  }

  if (gateState === "denied") {
    const diag: Readonly<MiniAppAccessDiagnostics> =
      deniedDiag ??
      buildFallbackDiagnostics(
        "禁止从外部浏览器直接访问。仅限 SuperAdmin 在与 Bot 的 Telegram 私聊中打开 Mini App。"
      );
    return (
      <div className="cf-error-page">
        <div className="cf-error-container">
          <div className="cf-header">
            <div className="cf-title-row">
              <span className="cf-main-title">Access denied</span>
              <span className="cf-code-pill">
                HTTP {diag.status} · {diag.code}
              </span>
            </div>
            <p className="cf-subtitle">
              You do not have permission to access this console from an external browser or unauthorized client.
            </p>
            <div className="cf-timestamp">{diag.timestamp}</div>
          </div>

          <div className="cf-status-band">
            <div className="cf-status-inner">
              <div className="cf-node">
                <div className="cf-node-icon ok">✓</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">Client</div>
                  <div className="cf-node-title">Browser</div>
                  <div className="cf-node-state ok">Working</div>
                </div>
              </div>

              <div className="cf-node">
                <div className="cf-node-icon err">✕</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">Access Gateway</div>
                  <div className="cf-node-title">Auth Guard</div>
                  <div className="cf-node-state err">{diag.status} Denied</div>
                </div>
              </div>

              <div className="cf-node">
                <div className="cf-node-icon ok">✓</div>
                <div className="cf-node-meta">
                  <div className="cf-node-sub">Origin Service</div>
                  <div className="cf-node-title">{diag.host}</div>
                  <div className="cf-node-state ok">Protected</div>
                </div>
              </div>
            </div>
          </div>

          <div className="cf-details-grid">
            <div className="cf-detail-col">
              <h2>What happened?</h2>
              <p>
                This endpoint enforces strict Telegram WebApp signature verification and administrator access control. The request you performed did not pass policy validation and was rejected.
              </p>
              <div className="cf-reason-box">
                <strong>Policy Detail ({diag.code}):</strong> {diag.error}
              </div>
            </div>
            <div className="cf-detail-col">
              <h2>What can I do?</h2>
              <p>
                Direct HTTP access outside Telegram is prohibited. If you are the configured SuperAdmin, open the private chat with the Bot in Telegram, launch the <strong>Dashboard</strong> button, and enter your access password.
              </p>
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
    const ttlMinutes: number = Math.round(MINI_APP_SESSION_TTL_MS / 60_000);
    return (
      <div className="auth-gate-wrap">
        <div className="card auth-gate-card">
          <div className="card-title">
            <span>{MINI_APP_HTML_TITLE}</span>
            <span className="badge ok">
              {unsafeUserId !== undefined ? `SuperAdmin #${unsafeUserId}` : "SuperAdmin 专属"}
            </span>
          </div>
          <p className="auth-gate-desc">
            Telegram 签名核验已通过。请输入配置的访问密码（<code>mini_app.password</code>）以解锁控制台，单次认证有效期为{" "}
            <strong>{ttlMinutes} 分钟</strong>；连续输错{" "}
            <strong>{MINI_APP_PASSWORD_MAX_ATTEMPTS} 次</strong>将锁定当前管理员 ID 30 分钟。
          </p>
          <form onSubmit={handlePasswordSubmit} className="auth-gate-form">
            <input
              type="password"
              className="auth-gate-input"
              placeholder="请输入 Mini App 访问密码"
              autoComplete="current-password"
              value={passwordInput}
              disabled={passwordBusy}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                setPasswordInput(
                  (event.currentTarget as unknown as { readonly value: string }).value
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
              {passwordBusy ? "正在验证密码…" : "验证并进入控制台"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div>
      <header>
        <h1>{MINI_APP_HTML_TITLE}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span className={`badge ${statusReady ? "ok" : ""}`}>
            {unsafeUserId !== undefined ? `SuperAdmin #${unsafeUserId}` : "SuperAdmin 专属"}
          </span>
          {sessionExpiresAt !== null
            ? (
              <button
                type="button"
                className="btn"
                onClick={(): void => {
                  lockForExpiredSession("已手动锁定控制台，请重新输入访问密码。");
                }}
              >
                锁定
              </button>
            )
            : null}
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === "status" ? "active" : ""}
          onClick={(): void => {
            setActiveTab("status");
          }}
        >
          首页状态
        </button>
        <button
          type="button"
          className={activeTab === "chats" ? "active" : ""}
          onClick={(): void => {
            setActiveTab("chats");
          }}
        >
          已初始化群
        </button>
        <button
          type="button"
          className={activeTab === "identities" ? "active" : ""}
          onClick={(): void => {
            setActiveTab("identities");
          }}
        >
          黑白名单与权限
        </button>
        <button
          type="button"
          className={activeTab === "gallery" ? "active" : ""}
          onClick={(): void => {
            setActiveTab("gallery");
          }}
        >
          图库
        </button>
      </nav>

      {activeTab === "status"
        ? (
          <StatusTab
            initialStatus={initialStatus}
            onStatusLoaded={handleStatusLoaded}
            onToast={showToast}
          />
        )
        : null}

      {activeTab === "chats"
        ? <ChatsTab onToast={showToast} />
        : null}

      {activeTab === "identities"
        ? <IdentitiesTab onToast={showToast} />
        : null}

      {activeTab === "gallery"
        ? <GalleryTab onToast={showToast} />
        : null}

      {toastText !== null
        ? <div className="toast">{toastText}</div>
        : null}
    </div>
  );
}
