import type React from "react";
import { MINI_APP_CONFIRM_CLOSE_ANIMATION_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { AlertSvgIcon, CloseSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppConfirmModalState, MiniAppUiStoreState } from "../store/app";
import type { MiniAppLanguage } from "../types/miniApp/ui";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";

/**
 * 渲染 `requestConfirm` 发起的自定义确认弹窗。
 * 按递增 `requestSeq` 重播连续请求的进入动画，关闭时保留快照播放收起动画；按钮优先展示请求指定的自定义文案，缺省回退至 `t.confirmDialog` 默认文案；点击遮罩、关闭或取消按钮均按取消结算。
 *
 * @returns React 节点或 `null`
 */
export function ConfirmModal(): React.JSX.Element | null {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const confirmModal: Readonly<MiniAppConfirmModalState> | null = useMiniAppStore(
    (state: MiniAppUiStoreState): Readonly<MiniAppConfirmModalState> | null =>
      state.confirmModal
  );
  const resolveConfirm: (accepted: boolean) => void = useMiniAppStore(
    (state: MiniAppUiStoreState): ((accepted: boolean) => void) =>
      state.resolveConfirm
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const {
    displayValue: displayModal,
    isClosing,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppConfirmModalState>>> =
    useDelayedUnmount(confirmModal, MINI_APP_CONFIRM_CLOSE_ANIMATION_MS);

  if (displayModal === null) return null;
  const isDanger: boolean = displayModal.tone === "danger";
  const cancelLabel: string =
    displayModal.cancelLabel ?? t.confirmDialog.cancelButton;
  const confirmLabel: string =
    displayModal.confirmLabel ?? t.confirmDialog.confirmButton;
  return (
    <div
      key={displayModal.requestSeq}
      className={`confirm-backdrop ${isClosing ? "closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-hidden={isClosing}
      onClick={(): void => {
        if (!isClosing) {
          resolveConfirm(false);
        }
      }}
    >
      <div
        className={`confirm-dialog ${isDanger ? "confirm-danger" : ""} ${isClosing ? "closing" : ""}`}
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
            disabled={isClosing}
            onClick={(): void => {
              resolveConfirm(false);
            }}
            aria-label={cancelLabel}
          >
            <CloseSvgIcon size={14} />
          </button>
        </div>
        <div className="confirm-body">{displayModal.message}</div>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn"
            disabled={isClosing}
            onClick={(): void => {
              resolveConfirm(false);
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${isDanger ? "danger" : "primary"}`}
            disabled={isClosing}
            onClick={(): void => {
              resolveConfirm(true);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
