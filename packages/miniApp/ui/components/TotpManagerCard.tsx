import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import type { MiniAppLanguage } from "../../../types/miniApp";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../../../types/miniAppTotp";
import { LockSvgIcon, RefreshSvgIcon, TrashSvgIcon } from "../../miniAppResoures";
import {
  deleteMiniAppTotp,
  enableMiniAppTotp,
  fetchMiniAppTotpStatus,
  setupMiniAppTotp,
} from "../api";
import { formatTime, waitMinimumLoadingDuration } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";

/** `TotpManagerCard` 组件的属性参数。 */
export interface TotpManagerCardProps {
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * Google Authenticator (TOTP) 唯一验证器的前端控制台生成二维码、添加、修改与删除管理卡片。
 * @param props 组件属性
 * @returns React 节点
 */
export function TotpManagerCard({
  onToast,
}: TotpManagerCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [totpStatus, setTotpStatus]: [
    Readonly<MiniAppTotpStatusView> | null,
    React.Dispatch<React.SetStateAction<Readonly<MiniAppTotpStatusView> | null>>
  ] = useState<Readonly<MiniAppTotpStatusView> | null>(null);
  const [setupData, setSetupData]: [
    Readonly<MiniAppTotpSetupResponse> | null,
    React.Dispatch<
      React.SetStateAction<Readonly<MiniAppTotpSetupResponse> | null>
    >
  ] = useState<Readonly<MiniAppTotpSetupResponse> | null>(null);
  const [codeInput, setCodeInput]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");
  const [busy, setBusy]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(true);
  const requestSeqRef: React.RefObject<number> = useRef<number>(0);

  const loadTotpStatus: () => Promise<void> = useCallback(async (): Promise<void> => {
    const reqId: number = ++requestSeqRef.current;
    const startedAt: number = Date.now();
    setLoadingStatus(true);
    try {
      const next: Readonly<MiniAppTotpStatusView> =
        await fetchMiniAppTotpStatus();
      await waitMinimumLoadingDuration(startedAt);
      if (reqId !== requestSeqRef.current) {
        return;
      }
      setTotpStatus(next);
      useMiniAppStore
        .getState()
        .setAuthMode(next.enabled ? "totp" : "password");
    } catch (_error: unknown) {
      await waitMinimumLoadingDuration(startedAt);
      // 保持静默，由主状态轮询统一处理网络或会话错误
    } finally {
      if (reqId === requestSeqRef.current) {
        setLoadingStatus(false);
      }
    }
  }, []);

  useEffect((): void => {
    void loadTotpStatus();
  }, [loadTotpStatus]);

  async function handleStartSetup(): Promise<void> {
    setBusy(true);
    try {
      const res: Readonly<MiniAppTotpSetupResponse> = await setupMiniAppTotp();
      setSetupData(res);
      setCodeInput("");
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyEnable(
    event?: React.SyntheticEvent<HTMLFormElement>
  ): Promise<void> {
    event?.preventDefault();
    const trimmed: string = codeInput.trim();
    if (!/^\d{6}$/u.test(trimmed)) {
      onToast(t.gate.totpEmptyHint);
      return;
    }
    setBusy(true);
    try {
      const res: Readonly<MiniAppTotpMutationResponse> =
        await enableMiniAppTotp(trimmed);
      setTotpStatus(res.status);
      setSetupData(null);
      setCodeInput("");
      useMiniAppStore
        .getState()
        .setAuthMode(res.status.enabled ? "totp" : "password");
      onToast(res.message);
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTotp(): Promise<void> {
    const confirmed: boolean = await useMiniAppStore
      .getState()
      .requestConfirm(t.totp.confirmDeleteTotp, "danger");
    if (!confirmed) return;
    setBusy(true);
    try {
      const res: Readonly<MiniAppTotpMutationResponse> =
        await deleteMiniAppTotp();
      setTotpStatus(res.status);
      setSetupData(null);
      setCodeInput("");
      useMiniAppStore.getState().setAuthMode("password");
      onToast(res.message);
    } catch (error: unknown) {
      onToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const enabled: boolean = totpStatus?.enabled === true;

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <LockSvgIcon size={15} />
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
        <div className="card auth-gate-skeleton" aria-busy="true">
          <div className="skeleton-row-between">
            <div className="skeleton-line skeleton-title-bar" />
            <div className="skeleton-line skeleton-badge-pill" />
          </div>
          <div className="skeleton-auth-desc">
            <div className="skeleton-line" style={{ width: "88%" }} />
            <div className="skeleton-line" style={{ width: "62%" }} />
          </div>
          <div className="totp-actions-row">
            <div className="skeleton-line skeleton-totp-btn" />
          </div>
        </div>
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
                  void handleStartSetup();
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
                    void handleDeleteTotp();
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
                void handleVerifyEnable(e);
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
                    onClick={(): void => {
                      setSetupData(null);
                      setCodeInput("");
                    }}
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
