import type React from "react";
import { MINI_APP_TARGETS_SKELETON_ROW_INDICES } from "../../consts/miniApp";

/**
 * 渲染受管群目标管理弹窗内底部数据条目列表的加载骨架屏（保留顶部新增/编辑按钮或表单，仅对下方数据条目展示 3 行流光占位）。
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
