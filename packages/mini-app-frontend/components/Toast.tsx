import type React from "react";
import { AlertSvgIcon, CloseSvgIcon, StatusSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppToastTone, MiniAppUiStoreState } from "../store/app";

/**
 * 渲染顶部 Toast 提示（无提示文案时不渲染）。
 *
 * @returns React 节点或 `null`
 */
export function Toast(): React.JSX.Element | null {
  const toastText: string = useMiniAppStore(
    (state: MiniAppUiStoreState): string => state.toastText
  );
  const toastTone: MiniAppToastTone = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppToastTone => state.toastTone
  );
  const clearToast: () => void = useMiniAppStore(
    (state: MiniAppUiStoreState): (() => void) => state.clearToast
  );

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
        onClick={clearToast}
        aria-label="Close"
      >
        <CloseSvgIcon size={14} />
      </button>
    </div>
  );
}
