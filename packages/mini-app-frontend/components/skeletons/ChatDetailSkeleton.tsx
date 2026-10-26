import type React from "react";
import { MINI_APP_FEATURE_KEYS } from "../../consts/miniApp";
import type { MiniAppFeatureKey } from "../../types/miniApp";

/**
 * 渲染受管群详细状态与功能开关面板的专属双卡片骨架（群状态诊断卡 + 7 项带拨杆胶囊的功能开关行）。
 *
 * @returns React 节点
 */
export function ChatDetailSkeleton(): React.JSX.Element {
  return (
    <div className="skeleton-detail-wrap animate-fade-in" aria-hidden="true">
      <div className="card">
        <div className="skeleton-row-between">
          <div className="skeleton-line skeleton-title-bar" />
          <div className="skeleton-line skeleton-badge-pill" />
        </div>
        <div className="skeleton-line skeleton-sub-bar" />
        <div className="skeleton-line skeleton-perm-banner" />
      </div>
      <div className="card">
        <div className="skeleton-line skeleton-section-bar" />
        {MINI_APP_FEATURE_KEYS.map((key: MiniAppFeatureKey): React.JSX.Element => (
          <div key={key} className="row skeleton-switch-row">
            <div className="row-main">
              <div className="skeleton-title-with-badge">
                <div className="skeleton-line skeleton-switch-label" />
                <div className="skeleton-line skeleton-cmd-pill" />
              </div>
              <div className="skeleton-line skeleton-switch-desc" />
            </div>
            <div className="skeleton-line skeleton-switch-pill" />
          </div>
        ))}
      </div>
    </div>
  );
}
