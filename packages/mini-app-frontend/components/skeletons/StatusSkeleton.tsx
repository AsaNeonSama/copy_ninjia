import { useState } from "react";
import type React from "react";
import {
  MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES,
  MINI_APP_STATUS_SKELETON_MEMORY_INDICES,
} from "../../consts/miniApp";
import { DEFAULT_STATUS_QUAD_MOSAIC, generateStatusQuadMosaic } from "../../libs/statusQuadMosaic";
import type { StatusQuadMosaicLayout } from "../../types/statusMosaic";

/** `StatusSkeleton` 实时状态骨架屏组件的属性参数。 */
export interface StatusSkeletonProps {
  /** 顶部四象限拼块的随机多边形裁剪布局（缺省时组件挂载自行生成一份稳定布局）。 */
  readonly quadMosaic?: Readonly<StatusQuadMosaicLayout>;
}

/**
 * 渲染实时状态页加载骨架屏（包含 `.status-overview-card` 顶部外矩形内分离不规则四象限拼块骨架、CPU 仪表环、出站门控与三栏内存进度卡，以及原样 6 项子系统能力折叠行卡片）。
 *
 * @param props 可选的四象限随机折线拼块布局参数
 * @returns React 节点
 */
export function StatusSkeleton({
  quadMosaic,
}: StatusSkeletonProps): React.JSX.Element {
  const fallbackMosaic: Readonly<StatusQuadMosaicLayout> | null = useState<
    Readonly<StatusQuadMosaicLayout> | null
  >((): Readonly<StatusQuadMosaicLayout> | null =>
    quadMosaic === undefined ? generateStatusQuadMosaic() : null
  )[0];
  const resolvedMosaic: Readonly<StatusQuadMosaicLayout> =
    quadMosaic ?? fallbackMosaic ?? DEFAULT_STATUS_QUAD_MOSAIC;
  return (
    <div className="skeleton-detail-wrap" aria-busy="true" aria-hidden="true">
      <div className="card status-overview-card">
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
          <div className="stat-quad-mosaic stat-quad-mosaic-skeleton">
            <div
              className="stat-box stat-quad-tile stat-quad-q1"
              style={{ "--stat-quad-clip": resolvedMosaic.q1Clip } as React.CSSProperties}
            >
              <div
                className="skeleton-line"
                style={{ width: "52%", height: "13px" }}
              />
              <div
                className="skeleton-line skeleton-stat-value"
                style={{ width: "68%" }}
              />
              <div
                className="skeleton-line"
                style={{ width: "60%", height: "16px" }}
              />
            </div>
            <div
              className="stat-box stat-box-cpu stat-quad-tile stat-quad-q2"
              style={{ "--stat-quad-clip": resolvedMosaic.q2Clip } as React.CSSProperties}
            >
              <div className="stat-cpu-row">
                <div className="stat-cpu-main">
                  <div
                    className="skeleton-line"
                    style={{ width: "58%", height: "13px" }}
                  />
                  <div
                    className="skeleton-line skeleton-stat-value"
                    style={{ width: "64%" }}
                  />
                  <div
                    className="skeleton-line"
                    style={{ width: "74%", height: "16px" }}
                  />
                </div>
                <div className="skeleton-line skeleton-cpu-ring" />
              </div>
            </div>
            <div
              className="stat-box stat-quad-tile stat-quad-q3"
              style={{ "--stat-quad-clip": resolvedMosaic.q3Clip } as React.CSSProperties}
            >
              <div
                className="skeleton-line"
                style={{ width: "56%", height: "13px" }}
              />
              <div
                className="skeleton-line skeleton-stat-value"
                style={{ width: "42%" }}
              />
              <div
                className="skeleton-line"
                style={{ width: "72%", height: "16px" }}
              />
            </div>
            <div
              className="stat-box stat-quad-tile stat-quad-q4"
              style={{ "--stat-quad-clip": resolvedMosaic.q4Clip } as React.CSSProperties}
            >
              <div
                className="skeleton-line"
                style={{ width: "54%", height: "13px" }}
              />
              <div
                className="skeleton-line skeleton-stat-value"
                style={{ width: "38%" }}
              />
              <div
                className="skeleton-line"
                style={{ width: "82%", height: "16px" }}
              />
            </div>
          </div>
          <div className="stat-box stat-box-outbound">
            <div className="stat-outbound-head">
              <div
                className="skeleton-line"
                style={{ width: "58%", height: "13px" }}
              />
              <div
                className="skeleton-line skeleton-cmd-pill"
                style={{ width: "42px", height: "20px" }}
              />
            </div>
            <div
              className="skeleton-line skeleton-stat-value"
              style={{ width: "48%" }}
            />
            <div className="skeleton-line stat-skeleton-bar" />
            <div
              className="skeleton-line"
              style={{ width: "76%", height: "14px" }}
            />
          </div>
          <div className="stat-box stat-box-memory">
            <div className="memory-metrics-row">
              {MINI_APP_STATUS_SKELETON_MEMORY_INDICES.map(
                (idx: number): React.JSX.Element => (
                  <div key={idx} className="memory-metric-card">
                    <div
                      className="skeleton-line"
                      style={{ width: "56%", height: "11px" }}
                    />
                    <div className="skeleton-line skeleton-memory-value" />
                  </div>
                )
              )}
            </div>
            <div className="memory-bar-section">
              <div className="skeleton-line stat-skeleton-bar" />
              <div className="memory-legend-grid">
                {MINI_APP_STATUS_SKELETON_MEMORY_INDICES.map(
                  (idx: number): React.JSX.Element => (
                    <div key={idx} className="memory-legend-item">
                      <div className="skeleton-line skeleton-legend-dot" />
                      <div
                        className="skeleton-line"
                        style={{ width: "44%", height: "13px" }}
                      />
                      <div
                        className="skeleton-line"
                        style={{
                          width: "36%",
                          height: "13px",
                          marginLeft: "auto",
                          marginRight: "3px",
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
                  <div className="skeleton-line skeleton-dot-chip" />
                  <div
                    className="skeleton-line skeleton-cap-title"
                    style={{
                      width: `${idx % 2 === 0 ? 44 : 54}%`,
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
                  <div className="skeleton-line skeleton-chevron-box" />
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
