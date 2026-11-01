import { Fragment } from "react";
import type React from "react";

/** `ListSkeletonRows` 的属性参数。 */
export interface ListSkeletonRowsProps {
  /** 骨架卡片行数。 */
  readonly count: number;
}

/**
 * 渲染受管群列表与黑白名单列表共用的两行式骨架占位卡片。
 *
 * @param props 骨架行数
 * @returns React 节点
 */
export function ListSkeletonRows({ count }: ListSkeletonRowsProps): React.JSX.Element {
  const rows: React.JSX.Element[] = [];
  for (let i: number = 0; i < count; i += 1) {
    rows.push(
      <div key={i} className="skeleton-card">
        <div className="skeleton-line medium" />
        <div className="skeleton-line wide" />
      </div>
    );
  }
  return <Fragment>{rows}</Fragment>;
}
