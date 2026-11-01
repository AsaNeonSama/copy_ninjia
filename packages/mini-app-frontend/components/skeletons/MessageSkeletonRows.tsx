import { Fragment } from "react";
import type React from "react";

/** `MessageSkeletonRows` 的属性参数。 */
export interface MessageSkeletonRowsProps {
  /** 骨架卡片行数。 */
  readonly count: number;
}

/**
 * 渲染发言列表骨架占位卡片（含头像徽章、作者信息行与消息气泡骨架）。
 *
 * @param props 骨架行数
 * @returns React 节点
 */
export function MessageSkeletonRows({ count }: MessageSkeletonRowsProps): React.JSX.Element {
  const rows: React.JSX.Element[] = [];
  for (let i: number = 0; i < count; i += 1) {
    rows.push(
      <div key={i} className="skeleton-card msg-skeleton-card">
        <div className="msg-head">
          <div className="skeleton-line msg-skeleton-avatar" />
          <div className="msg-author-col">
            <div className="skeleton-row-between" style={{ marginBottom: 0 }}>
              <div className="skeleton-line" style={{ width: "46%", height: "12px" }} />
              <div className="skeleton-line" style={{ width: "36px", height: "14px" }} />
            </div>
            <div className="skeleton-line" style={{ width: "68%", height: "9px" }} />
          </div>
        </div>
        <div className="skeleton-line msg-skeleton-bubble" />
      </div>
    );
  }
  return <Fragment>{rows}</Fragment>;
}
