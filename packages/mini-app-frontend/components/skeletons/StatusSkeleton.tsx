import type React from "react";
import {
  MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES,
  MINI_APP_STATUS_SKELETON_MEMORY_INDICES,
} from "../../consts/miniApp";

/**
 * 渲染实时状态页专属骨架屏（1:1 对应顶部 5 项指标卡、CPU 环形图、全宽三栏内存进度卡与 6 项默认收起的能力折叠行）。
 *
 * @returns React 节点
 */
export function StatusSkeleton(): React.JSX.Element {
  return (
    <div className="skeleton-detail-wrap" aria-busy="true">
      <div className="card">
        <div className="skeleton-row-between">
          <div
            className="skeleton-line skeleton-title-bar"
            style={{ width: "36%" }}
          />
          <div
            className="skeleton-line skeleton-badge-pill"
            style={{ width: "86px" }}
          />
        </div>
        <div className="grid-2">
          <div className="stat-box">
            <div
              className="skeleton-line"
              style={{ width: "52%", height: "11px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "68%", height: "20px", borderRadius: "6px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "60%", height: "10px" }}
            />
          </div>
          <div className="stat-box stat-box-cpu">
            <div className="stat-cpu-row">
              <div className="stat-cpu-main">
                <div
                  className="skeleton-line"
                  style={{ width: "58%", height: "11px" }}
                />
                <div
                  className="skeleton-line"
                  style={{ width: "64%", height: "20px", borderRadius: "6px" }}
                />
                <div
                  className="skeleton-line"
                  style={{ width: "74%", height: "10px" }}
                />
              </div>
              <div className="skeleton-line skeleton-cpu-ring" />
            </div>
          </div>
          <div className="stat-box">
            <div
              className="skeleton-line"
              style={{ width: "56%", height: "11px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "42%", height: "20px", borderRadius: "6px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "72%", height: "10px" }}
            />
          </div>
          <div className="stat-box">
            <div
              className="skeleton-line"
              style={{ width: "54%", height: "11px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "38%", height: "20px", borderRadius: "6px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "82%", height: "10px" }}
            />
          </div>
          <div className="stat-box stat-box-outbound">
            <div className="stat-outbound-head">
              <div
                className="skeleton-line"
                style={{ width: "58%", height: "11px" }}
              />
              <div
                className="skeleton-line skeleton-cmd-pill"
                style={{ width: "36px" }}
              />
            </div>
            <div
              className="skeleton-line"
              style={{ width: "48%", height: "20px", borderRadius: "6px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "100%", height: "6px" }}
            />
            <div
              className="skeleton-line"
              style={{ width: "76%", height: "10px" }}
            />
          </div>
          <div className="stat-box stat-box-memory">
            <div className="memory-metrics-row">
              {MINI_APP_STATUS_SKELETON_MEMORY_INDICES.map(
                (idx: number): React.JSX.Element => (
                  <div key={idx} className="memory-metric-card">
                    <div
                      className="skeleton-line"
                      style={{ width: "56%", height: "10px" }}
                    />
                    <div
                      className="skeleton-line"
                      style={{
                        width: "74%",
                        height: "15px",
                        borderRadius: "5px",
                      }}
                    />
                  </div>
                )
              )}
            </div>
            <div className="memory-bar-section">
              <div
                className="skeleton-line"
                style={{ width: "100%", height: "10px" }}
              />
              <div className="memory-legend-grid">
                {MINI_APP_STATUS_SKELETON_MEMORY_INDICES.map(
                  (idx: number): React.JSX.Element => (
                    <div key={idx} className="memory-legend-item">
                      <div
                        className="skeleton-line"
                        style={{
                          width: "7px",
                          height: "7px",
                          borderRadius: "50%",
                          flexShrink: 0,
                        }}
                      />
                      <div
                        className="skeleton-line"
                        style={{ width: "44%", height: "10px" }}
                      />
                      <div
                        className="skeleton-line"
                        style={{
                          width: "36%",
                          height: "10px",
                          marginLeft: "auto",
                        }}
                      />
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <div
            className="skeleton-line skeleton-section-bar"
            style={{ width: "46%", marginBottom: 0 }}
          />
        </div>
        <div className="cap-list">
          {MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES.map(
            (idx: number): React.JSX.Element => (
              <div key={idx} className="cap-block skeleton-cap-row">
                <div className="cap-header-main">
                  <div
                    className="skeleton-line"
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      flexShrink: 0,
                    }}
                  />
                  <div
                    className="skeleton-line"
                    style={{
                      width: `${idx % 2 === 0 ? 44 : 54}%`,
                      height: "13px",
                      borderRadius: "5px",
                    }}
                  />
                  <div
                    className="skeleton-line skeleton-cmd-pill"
                    style={{ width: "42px" }}
                  />
                </div>
                <div className="cap-header-right">
                  <div
                    className="skeleton-line skeleton-badge-pill"
                    style={{ width: "52px", height: "20px" }}
                  />
                  <div
                    className="skeleton-line"
                    style={{
                      width: "24px",
                      height: "24px",
                      borderRadius: "7px",
                      flexShrink: 0,
                    }}
                  />
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
