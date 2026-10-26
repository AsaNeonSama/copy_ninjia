import type React from "react";

/**
 * 渲染验证器管理卡片首次加载时的骨架（标题、徽章、两行说明与操作按钮占位）。
 *
 * @returns React 节点
 */
export function TotpSkeleton(): React.JSX.Element {
  return (
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
  );
}
