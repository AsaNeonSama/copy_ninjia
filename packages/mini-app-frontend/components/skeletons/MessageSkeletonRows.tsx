import { Fragment } from "react";
import type React from "react";

/** `MessageSkeletonRows` 的属性参数。 */
export interface MessageSkeletonRowsProps {
  /** 骨架卡片行数。 */
  readonly count: number;
}

/**
 * 渲染热发言列表的骨架占位卡片集合（含头像、作者条、序号徽章、元信息条与消息气泡占位）。
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
            <div className="skeleton-row-between msg-skeleton-head-row">
              <div className="skeleton-line msg-skeleton-author" />
              <div className="skeleton-line msg-skeleton-seq" />
            </div>
            <div className="skeleton-line msg-skeleton-meta" />
          </div>
        </div>
        <div className="skeleton-line msg-skeleton-bubble" />
      </div>
    );
  }
  return <Fragment>{rows}</Fragment>;
}
