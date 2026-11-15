import type React from "react";

/**
 * 渲染配合 CSS `@keyframes miniapp-brutal-dot-step` 节拍跳动的三枚方形加载块指示节点。
 *
 * @returns React 节点
 */
export function LoadingDotsWave(): React.JSX.Element {
  return (
    <span className="join-clean-loading-dots loading-dots-wave" aria-hidden="true">
      <span className="loading-dot-block" />
      <span className="loading-dot-block" />
      <span className="loading-dot-block" />
    </span>
  );
}
