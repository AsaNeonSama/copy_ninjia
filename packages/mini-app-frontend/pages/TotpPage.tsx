import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import type React from "react";
import { CollapseGrid, TriggerCollapseGrid } from "../components/animations/CollapseGrid";
import { scrollViewportToExpandedBody } from "../components/animations/expandFollowScroll";
import type { ViewportRectElement } from "../components/animations/expandFollowScroll";
import { LoadingDotsWave } from "../components/animations/LoadingDotsWave";
import { useDelayedUnmount } from "../components/animations/useDelayedUnmount";
import type { DelayedUnmountState } from "../components/animations/useDelayedUnmount";
import { TotpSkeleton } from "../components/skeletons/TotpSkeleton";
import { MINI_APP_TOTP_SETUP_COLLAPSE_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { formatTime } from "../libs/formatters";
import { LockSvgIcon, RefreshSvgIcon, TrashSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createTotpStore } from "../store/totp";
import type { MiniAppTotpStore, MiniAppTotpStoreState } from "../store/totp";
import type { MiniAppLanguage } from "../types/miniApp";
import type { MiniAppTotpSetupResponse } from "../types/miniAppTotp";

/** `TotpPage` 组件属性。 */
export interface TotpPageProps {
  /** 可选的状态仓库工厂（默认 `createTotpStore`）。 */
  readonly storeFactory?: () => MiniAppTotpStore;
}

/**
 * Google Authenticator (TOTP) 唯一验证器的前端控制台生成二维码、添加、修改与删除管理页面
 * （点击添加或修改验证器时平滑收起顶部触发按钮并展开绑定表单，展开结束后按 `scrollViewportToExpandedBody` 让视口平滑跟滚，提交 6 位动态码核验时按钮展示三点波浪加载动效，取消时保留二维码快照完成收起过渡）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function TotpPage({
  storeFactory = createTotpStore,
}: TotpPageProps): React.JSX.Element {
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
  }: MiniAppTotpStoreState = useComponentStore(storeFactory);

  const cardRef: React.RefObject<ViewportRectElement | null> =
    useRef<ViewportRectElement | null>(null);
  const setCardNode: (el: ViewportRectElement | null) => void =
    useCallback((el: ViewportRectElement | null): void => {
      cardRef.current = el;
    }, []);
  const handleSetupExpandEnd: (gridElement: ViewportRectElement) => void =
    useCallback((gridElement: ViewportRectElement): void => {
      const cardEl: ViewportRectElement | null = cardRef.current;
      if (
        cardEl === null ||
        typeof cardEl.getBoundingClientRect !== "function" ||
        typeof gridElement.getBoundingClientRect !== "function"
      ) {
        return;
      }
      const gridRect: { readonly top: number; readonly height: number } =
        gridElement.getBoundingClientRect();
      scrollViewportToExpandedBody({
        blockTop: cardEl.getBoundingClientRect().top,
        bodyTop: gridRect.top,
        bodyHeight: gridRect.height,
      });
    }, []);

  const {
    displayValue: displaySetupData,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppTotpSetupResponse>>> =
    useDelayedUnmount(setupData, MINI_APP_TOTP_SETUP_COLLAPSE_MS);
  const qrSvgHtml: string = displaySetupData?.qrSvg ?? "";
  const qrInnerHtml: Readonly<{ readonly __html: string }> = useMemo(
    (): Readonly<{ readonly __html: string }> => ({ __html: qrSvgHtml }),
    [qrSvgHtml]
  );

  useEffect((): void => {
    void loadTotpStatus();
  }, [loadTotpStatus]);

  const enabled: boolean = totpStatus?.enabled === true;
  const setupOpen: boolean = setupData !== null;
  const verifyBusy: boolean = busy && setupOpen;

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

      {totpStatus === null ? (
        <TotpSkeleton />
      ) : (
        <div
          ref={setCardNode}
          className={`card ${loadingStatus ? "content-refreshing" : ""}`}
        >
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

          <TriggerCollapseGrid
            collapsed={setupOpen}
            gridClassName="totp-trigger-collapse-grid"
            innerClassName="totp-collapse-inner"
          >
            <div className="totp-actions-row">
              <button
                type="button"
                className="btn primary icon-btn"
                disabled={busy || setupOpen}
                tabIndex={setupOpen ? -1 : 0}
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
                  disabled={busy || setupOpen}
                  tabIndex={setupOpen ? -1 : 0}
                  onClick={(): void => {
                    void deleteTotp();
                  }}
                >
                  <TrashSvgIcon size={14} />
                  <span>{t.totp.deleteButton}</span>
                </button>
              ) : null}
            </div>
          </TriggerCollapseGrid>

          <CollapseGrid
            expanded={setupOpen}
            gridClassName="totp-setup-collapse-grid"
            innerClassName="totp-collapse-inner"
            onExpandEnd={handleSetupExpandEnd}
          >
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
                dangerouslySetInnerHTML={qrInnerHtml}
              />
              <div className="totp-secret-line">
                <span>{t.totp.secretLabel}</span>
                <code>{displaySetupData?.secret ?? ""}</code>
              </div>
              <div className="totp-verify-stack">
                <input
                  type="text"
                  className="totp-verify-input"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t.totp.codePlaceholder}
                  value={codeInput}
                  disabled={busy || !setupOpen}
                  tabIndex={setupOpen ? 0 : -1}
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
                    disabled={busy || !setupOpen}
                    tabIndex={setupOpen ? 0 : -1}
                    onClick={cancelSetup}
                  >
                    {t.totp.cancelSetupButton}
                  </button>
                  <button
                    type="submit"
                    className={`btn primary icon-btn totp-verify-submit ${verifyBusy ? "is-loading" : ""}`}
                    disabled={busy || !setupOpen}
                    aria-busy={verifyBusy}
                    tabIndex={setupOpen ? 0 : -1}
                  >
                    {verifyBusy ? (
                      <LoadingDotsWave />
                    ) : (
                      <Fragment>
                        <LockSvgIcon size={14} />
                        <span>{t.totp.verifyEnableButton}</span>
                      </Fragment>
                    )}
                  </button>
                </div>
              </div>
            </form>
          </CollapseGrid>
        </div>
      )}
    </section>
  );
}
