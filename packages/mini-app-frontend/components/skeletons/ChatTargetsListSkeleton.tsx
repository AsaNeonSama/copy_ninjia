import type React from "react";
import { MINI_APP_TARGETS_SKELETON_ROW_INDICES } from "../../consts/miniApp";

/**
 * 渲染受管群目标管理弹窗内底部数据条目列表的加载骨架屏（3 行标题条、副标题条与操作按钮占位）。
 *
 * @returns React 节点
 */
export function ChatTargetsListSkeleton(): React.JSX.Element {
  return (
    <div
      className="chat-targets-skeleton-list animate-fade-in"
      aria-hidden="true"
    >
      {MINI_APP_TARGETS_SKELETON_ROW_INDICES.map(
        (index: number): React.JSX.Element => (
          <div key={index} className="chat-targets-skeleton-row">
            <div className="row-main">
              <div className="skeleton-line chat-targets-skeleton-row-title" />
              <div className="skeleton-line chat-targets-skeleton-row-sub" />
            </div>
            <div className="skeleton-line chat-targets-skeleton-action" />
          </div>
        )
      )}
    </div>
  );
}
