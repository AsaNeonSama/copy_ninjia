import type React from "react";

/**
 * 渲染配合 CSS `@keyframes miniapp-dot-wave` 跳动的三点波浪加载动效。
 *
 * @returns React 节点
 */
export function LoadingDotsWave(): React.JSX.Element {
  return (
    <span className="join-clean-loading-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
