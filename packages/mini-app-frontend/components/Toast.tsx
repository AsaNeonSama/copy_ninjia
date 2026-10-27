import { useMemo } from "react";
import type React from "react";
import { AlertSvgIcon, CloseSvgIcon, StatusSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppToastTone, MiniAppUiStoreState } from "../store/app";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";

/** Toast 淡出动画期间保留的文案与色调快照。 */
interface RenderedToastSnapshot {
  /** 提示正文。 */
  readonly text: string;
  /** 提示色调。 */
  readonly tone: MiniAppToastTone;
}

/** Toast 淡出退场动画时长（毫秒，与 `overlays.css` 的 `0.2s` 齐平）。 */
const MINI_APP_TOAST_CLOSE_ANIMATION_MS: number = 200;

/**
 * 渲染底部 Toast 提示（支持淡入弹出与淡出退场动画，无提示文案且退场结束时不渲染）。
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

  const activeToast: Readonly<RenderedToastSnapshot> | null = useMemo(
    (): Readonly<RenderedToastSnapshot> | null =>
      toastText.length > 0 ? { text: toastText, tone: toastTone } : null,
    [toastText, toastTone]
  );

  const {
    displayValue: displayToast,
    isClosing,
  }: Readonly<DelayedUnmountState<Readonly<RenderedToastSnapshot>>> =
    useDelayedUnmount(activeToast, MINI_APP_TOAST_CLOSE_ANIMATION_MS);

  if (displayToast === null) return null;
  const isWarnOrDanger: boolean =
    displayToast.tone === "warning" || displayToast.tone === "danger";
  return (
    <div
      className={`toast ${isClosing ? "closing" : "show"} toast-${displayToast.tone}`}
      role="status"
      aria-hidden={isClosing}
    >
      <span className="toast-badge" aria-hidden="true">
        {isWarnOrDanger
          ? <AlertSvgIcon size={14} />
          : <StatusSvgIcon size={14} />}
      </span>
      <span className="toast-text">{displayToast.text}</span>
      <button
        type="button"
        className="toast-close"
        disabled={isClosing}
        onClick={clearToast}
        aria-label="Close"
      >
        <CloseSvgIcon size={14} />
      </button>
    </div>
  );
}
