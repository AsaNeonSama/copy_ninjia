import type React from "react";

/** `AuthGateSkeleton` 的属性参数。 */
export interface AuthGateSkeletonProps {
  /** 骨架卡片的无障碍说明（预检中提示文案）。 */
  readonly ariaLabel: string;
}

/**
 * 渲染访问预检阶段的门禁卡片骨架（标题、徽章、两行说明、输入框与提交按钮占位）。
 *
 * @param props 无障碍说明
 * @returns React 节点
 */
export function AuthGateSkeleton({ ariaLabel }: AuthGateSkeletonProps): React.JSX.Element {
  return (
    <div
      className="card auth-gate-card auth-gate-skeleton"
      aria-busy="true"
      aria-label={ariaLabel}
    >
      <div className="card-title">
        <span className="toolbar-hint" style={{ flex: 1, minWidth: 0 }}>
          <span className="skeleton-line skeleton-icon-badge" />
          <span className="skeleton-line skeleton-title-bar" />
        </span>
        <span className="skeleton-line skeleton-badge-pill" />
      </div>
      <div className="skeleton-auth-desc">
        <div className="skeleton-line" style={{ width: "92%" }} />
        <div className="skeleton-line" style={{ width: "66%" }} />
      </div>
      <div className="auth-gate-form">
        <div className="skeleton-line skeleton-auth-input" />
        <div className="skeleton-line skeleton-auth-btn" />
      </div>
    </div>
  );
}
