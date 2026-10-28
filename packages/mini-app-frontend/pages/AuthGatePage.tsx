import type React from "react";
import { LoadingDotsWave } from "../components/animations/LoadingDotsWave";
import { PrefsBar } from "../components/PrefsBar";
import { Toast } from "../components/Toast";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { getTelegramWebApp } from "../libs/telegram";
import { LockSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage, TelegramWebApp } from "../types/miniApp";
import type { MiniAppAuthMode } from "../types/miniAppTotp";

/**
 * 渲染访问密码或 Google Authenticator 6 位动态码门禁页（按服务端返回的登录模式切换输入形态，提交核验期间按钮展示三点波浪加载动效）。
 *
 * @returns React 节点
 */
export function AuthGatePage(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const authMode: MiniAppAuthMode = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppAuthMode => state.authMode
  );
  const passwordInput: string = useMiniAppStore(
    (state: MiniAppUiStoreState): string => state.passwordInput
  );
  const passwordBusy: boolean = useMiniAppStore(
    (state: MiniAppUiStoreState): boolean => state.passwordBusy
  );
  const passwordError: string | null = useMiniAppStore(
    (state: MiniAppUiStoreState): string | null => state.passwordError
  );
  const setPasswordInput: (value: string) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((value: string) => void) => state.setPasswordInput
  );
  const submitCredential: () => Promise<void> = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => Promise<void>) => state.submitCredential
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  const unsafeUserId: number | undefined = webApp?.initDataUnsafe?.user?.id;
  const isTotpGate: boolean = authMode === "totp";

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitCredential();
  };

  return (
    <div className="auth-gate-wrap animate-fade-in">
      <div className="gate-top-prefs"><PrefsBar /></div>
      <div className="card auth-gate-card">
        <div className="card-title">
          <span className="toolbar-hint">
            <span className="toolbar-icon-badge">
              <LockSvgIcon size={16} />
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
        <form onSubmit={handleSubmit} className="auth-gate-form">
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
            className={`btn primary auth-gate-submit ${passwordBusy ? "is-loading" : ""}`}
            disabled={passwordBusy || passwordInput.trim().length === 0}
            aria-busy={passwordBusy}
          >
            {passwordBusy
              ? <LoadingDotsWave />
              : isTotpGate
                ? t.gate.totpSubmitButton
                : t.gate.passwordSubmitButton}
          </button>
        </form>
      </div>
      <Toast />
    </div>
  );
}
