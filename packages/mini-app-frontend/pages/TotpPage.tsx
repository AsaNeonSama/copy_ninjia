import { useEffect } from "react";
import type React from "react";
import { TotpSkeleton } from "../components/skeletons/TotpSkeleton";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { formatTime } from "../libs/formatters";
import { LockSvgIcon, RefreshSvgIcon, TrashSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createTotpStore } from "../store/totp";
import type { MiniAppTotpStoreState } from "../store/totp";
import type { MiniAppLanguage } from "../types/miniApp";

/**
 * Google Authenticator (TOTP) 唯一验证器的前端控制台生成二维码、添加、修改与删除管理页面。
 *
 * @returns React 节点
 */
export function TotpPage(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    totpStatus,
    setupData,
    codeInput,
    busy,
    loadingStatus,
    loadTotpStatus,
    startSetup,
    setCodeInput,
    cancelSetup,
    verifyEnable,
    deleteTotp,
  }: MiniAppTotpStoreState = useComponentStore(createTotpStore);

  useEffect((): void => {
    void loadTotpStatus();
  }, [loadTotpStatus]);

  const enabled: boolean = totpStatus?.enabled === true;

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <LockSvgIcon size={16} />
          </span>
          <span>{t.totp.sectionTitle}</span>
        </span>
        <button
          type="button"
          className="btn icon-btn"
          disabled={busy || loadingStatus}
          onClick={(): void => {
            void loadTotpStatus();
          }}
        >
          <RefreshSvgIcon
            size={14}
            className={loadingStatus ? "spin-icon" : ""}
          />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {loadingStatus && totpStatus === null ? (
        <TotpSkeleton />
      ) : (
        <div className={`card ${loadingStatus ? "content-refreshing" : ""}`}>
          <div className="card-title">
            <span>{t.totp.sectionTitle}</span>
            <span className={`badge ${enabled ? "ok" : "warn"}`}>
              {enabled ? t.totp.enabledBadge : t.totp.disabledBadge}
            </span>
          </div>
          <div className="stat-sub" style={{ marginBottom: "10px" }}>
            {enabled
              ? t.totp.statusDescEnabled(
                totpStatus?.maskedSecret ?? "••••",
                formatTime(totpStatus?.createdAt ?? 0)
              )
              : t.totp.statusDescDisabled}
          </div>

          {setupData === null ? (
            <div className="totp-actions-row">
              <button
                type="button"
                className="btn primary icon-btn"
                disabled={busy}
                onClick={(): void => {
                  void startSetup();
                }}
              >
                <LockSvgIcon size={14} />
                <span>{enabled ? t.totp.modifyButton : t.totp.addButton}</span>
              </button>
              {enabled ? (
                <button
                  type="button"
                  className="btn danger icon-btn"
                  disabled={busy}
                  onClick={(): void => {
                    void deleteTotp();
                  }}
                >
                  <TrashSvgIcon size={14} />
                  <span>{t.totp.deleteButton}</span>
                </button>
              ) : null}
            </div>
          ) : (
            <form
              className="totp-setup-panel"
              onSubmit={(e: React.SyntheticEvent<HTMLFormElement>): void => {
                e.preventDefault();
                void verifyEnable();
              }}
            >
              <div className="stat-sub">{t.totp.qrGuideText}</div>
              <div
                className="totp-qr-box"
                dangerouslySetInnerHTML={{ __html: setupData.qrSvg }}
              />
              <div className="totp-secret-line">
                <span>{t.totp.secretLabel}</span>
                <code>{setupData.secret}</code>
              </div>
              <div className="totp-verify-stack">
                <input
                  type="text"
                  className="totp-verify-input"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t.totp.codePlaceholder}
                  value={codeInput}
                  disabled={busy}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
                    const rawVal: string = (
                      e.currentTarget as unknown as { readonly value: string }
                    ).value;
                    setCodeInput(rawVal.replace(/\D+/gu, "").slice(0, 6));
                  }}
                />
                <div className="totp-verify-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={cancelSetup}
                  >
                    {t.totp.cancelSetupButton}
                  </button>
                  <button
                    type="submit"
                    className="btn primary icon-btn"
                    disabled={busy}
                  >
                    <LockSvgIcon size={14} />
                    <span>
                      {busy ? t.totp.verifyingButton : t.totp.verifyEnableButton}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
