import type React from "react";

/** `LoadingBox` 的属性参数。 */
export interface LoadingBoxProps {
  /** 外层容器类名（默认 `"loading-box"`）。 */
  readonly className?: string;
  /** 骨架占位节点。 */
  readonly children: React.ReactNode;
}

/**
 * 渲染列表加载期间包裹骨架行的占位容器。
 *
 * @param props 容器类名与骨架节点
 * @returns React 节点
 */
export function LoadingBox({
  className = "loading-box",
  children,
}: LoadingBoxProps): React.JSX.Element {
  return (
    <div className={className} aria-hidden="true">
      <div className="skeleton-stack">{children}</div>
    </div>
  );
}
