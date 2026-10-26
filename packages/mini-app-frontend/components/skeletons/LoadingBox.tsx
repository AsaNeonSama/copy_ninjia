import type React from "react";

/** `LoadingBox` 的属性参数。 */
export interface LoadingBoxProps {
  /** 外层容器类名（默认 `"loading-box"`）。 */
  readonly className?: string;
  /** 骨架上方的加载提示文案。 */
  readonly text: string;
  /** 骨架占位节点。 */
  readonly children: React.ReactNode;
}

/**
 * 渲染「加载提示文案 + 骨架堆叠」的列表加载占位块。
 *
 * @param props 容器类名、提示文案与骨架节点
 * @returns React 节点
 */
export function LoadingBox({
  className = "loading-box",
  text,
  children,
}: LoadingBoxProps): React.JSX.Element {
  return (
    <div className={className}>
      <div className="loading-text">{text}</div>
      <div className="skeleton-stack">{children}</div>
    </div>
  );
}
