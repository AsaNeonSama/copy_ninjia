import { memo } from "react";
import type React from "react";
import { MINI_APP_CPU_RING_CIRCUMFERENCE } from "../consts/miniApp";
import type { MiniAppTranslations } from "../i18n";
import {
  formatClockTime,
  formatMemoryMb,
  formatUptime,
} from "../libs/formatters";
import type { MiniAppStatusView } from "../types/miniApp";

/** `StatusOverviewCard` 顶部资源概览卡片的属性参数。 */
export interface StatusOverviewCardProps {
  /** 实时运行状态快照。 */
  readonly status: Readonly<MiniAppStatusView>;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染顶部进程资源、活跃会话、出站门控与内存占用的概览卡片。
 *
 * @param props 状态快照与翻译字典
 * @returns React 节点
 */
function StatusOverviewCardView({
  status,
  t,
}: StatusOverviewCardProps): React.JSX.Element {
  const cpuClampedPercent: number = Math.min(
    100,
    Math.max(
      0,
      Number.isFinite(status.cpuAveragePercent) ? status.cpuAveragePercent : 0
    )
  );
  const cpuRingOffset: string = (
    MINI_APP_CPU_RING_CIRCUMFERENCE *
    (1 - cpuClampedPercent / 100)
  ).toFixed(2);
  const memoryTotal: number = Math.max(
    1,
    status.memoryTotalBytes,
    status.memoryCurrentRssBytes + status.memoryOtherBytes
  );
  const memoryProcessPercent: number = Math.min(
    100,
    Math.max(0, (status.memoryCurrentRssBytes / memoryTotal) * 100)
  );
  const memoryOtherPercent: number = Math.min(
    Math.max(0, 100 - memoryProcessPercent),
    Math.max(0, (status.memoryOtherBytes / memoryTotal) * 100)
  );
  const memoryTotalUsedBytes: number =
    status.memoryCurrentRssBytes + status.memoryOtherBytes;
  const memoryTotalUsedPercent: number = Math.min(
    100,
    Math.max(0, (memoryTotalUsedBytes / memoryTotal) * 100)
  );
  const memoryProcessBarWidth: number =
    status.memoryCurrentRssBytes > 0
      ? Math.max(memoryProcessPercent, 3)
      : 0;
  const memoryOtherBarWidth: number = Math.min(
    Math.max(0, 100 - memoryProcessBarWidth),
    status.memoryOtherBytes > 0 ? Math.max(memoryOtherPercent, 3) : 0
  );
  const outboundMax: number = Math.max(
    1,
    status.telegramOutbound.maxConcurrency
  );
  const outboundActivePercent: number = Math.min(
    100,
    Math.max(0, (status.telegramOutbound.inFlight / outboundMax) * 100)
  );
  const outboundRetryMax: number = Math.max(
    1,
    status.telegramOutbound.retryQueueMax
  );
  const outboundQueuedTotal: number =
    status.telegramOutbound.waiting +
    status.telegramOutbound.retryQueueSize;
  const outboundQueuePercent: number = Math.min(
    100,
    Math.max(0, (outboundQueuedTotal / outboundRetryMax) * 100)
  );
  const [gagSub, wedSub, verifySub, qaSub]: readonly [
    string,
    string,
    string,
    string
  ] = t.status.activeSessionsSub(status.activeSessions);
  const updatedAtText: string = t.status.updatedAtSub(
    formatClockTime(status.generatedAt)
  );

  return (
    <div className="card">
      <div className="card-title">
        <span>{t.tabs.status}</span>
        <span className="badge ok">
          {updatedAtText}
        </span>
      </div>
      <div className="grid-2">
        <div className="stat-box">
          <div className="stat-label">{t.status.uptimeLabel}</div>
          <div
            className={`stat-value ${status.uptimeMs > 0 ? "stat-value-active" : ""}`}
          >
            {formatUptime(status.uptimeMs)}
          </div>
          <div className="stat-sub">
            {updatedAtText}
          </div>
        </div>
        <div className="stat-box stat-box-cpu">
          <div className="stat-cpu-row">
            <div className="stat-cpu-main">
              <div className="stat-label">{t.status.cpuLoadLabel}</div>
              <div
                className={`stat-value ${status.cpuAveragePercent > 0 ? "stat-value-active" : ""}`}
              >
                {status.cpuAveragePercent.toFixed(2)}%
              </div>
              <div className="stat-sub">{t.status.cpuLoadSub}</div>
            </div>
            <div className="cpu-ring-wrap" aria-hidden="true">
              <svg
                className="cpu-ring-svg"
                width={48}
                height={48}
                viewBox="0 0 44 44"
              >
                <circle
                  className="cpu-ring-track"
                  cx={22}
                  cy={22}
                  r={17.5}
                />
                <circle
                  className={`cpu-ring-fill ${cpuClampedPercent >= 80 ? "high" : ""}`}
                  cx={22}
                  cy={22}
                  r={17.5}
                  strokeDasharray={String(MINI_APP_CPU_RING_CIRCUMFERENCE)}
                  strokeDashoffset={cpuRingOffset}
                />
              </svg>
              <span className="cpu-ring-text">
                {Math.round(cpuClampedPercent)}%
              </span>
            </div>
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">{t.status.managedChatsLabel}</div>
          <div
            className={`stat-value ${status.managedChatCount > 0 ? "stat-value-active" : ""}`}
          >
            {status.managedChatCount}
          </div>
          <div className="stat-sub">
            {t.status.managedChatsSub(
              status.whitelistCount,
              status.blocklistCount
            )}
          </div>
        </div>
        <div className="stat-box">
          <div className="stat-label">
            {t.status.activeSessionsLabel}
          </div>
          <div
            className={`stat-value ${status.activeSessions.total > 0 ? "stat-value-active" : ""}`}
          >
            {status.activeSessions.total}
          </div>
          <div className="stat-sub stat-sub-grid">
            <span>{gagSub}</span>
            <span>{wedSub}</span>
            <span>{verifySub}</span>
            <span>{qaSub}</span>
          </div>
        </div>
        <div className="stat-box stat-box-outbound">
          <div className="stat-outbound-head">
            <div className="stat-label">
              {t.status.outboundGateLabel}
            </div>
            <span className="stat-outbound-pill">
              {outboundActivePercent.toFixed(0)}%
            </span>
          </div>
          <div className="stat-value">
            <span
              className={
                status.telegramOutbound.inFlight > 0 ? "stat-value-active" : ""
              }
            >
              {status.telegramOutbound.inFlight}
            </span>{" "}
            / {status.telegramOutbound.maxConcurrency}
          </div>
          <div className="stat-bar-track" aria-hidden="true">
            <div
              className="stat-bar-fill"
              style={{
                width: `${Math.max(outboundActivePercent, status.telegramOutbound.inFlight > 0 ? 6 : 0).toFixed(1)}%`,
              }}
            />
            {outboundQueuedTotal > 0
              ? (
                <div
                  className="stat-bar-queue"
                  style={{
                    width: `${Math.max(outboundQueuePercent, 5).toFixed(1)}%`,
                  }}
                />
              )
              : null}
          </div>
          <div className="stat-sub">
            {t.status.outboundGateSub(
              status.telegramOutbound.waiting,
              status.telegramOutbound.retryQueueSize,
              status.telegramOutbound.retryQueueMax
            )}
          </div>
        </div>
        <div className="stat-box stat-box-memory">
          <div className="memory-metrics-row">
            <div className="memory-metric-card">
              <span className="memory-metric-label">
                {t.status.memoryCurrentLabel}
              </span>
              <span className="memory-metric-value">
                {formatMemoryMb(status.memoryCurrentRssBytes)}
              </span>
            </div>
            <div className="memory-metric-card peak">
              <span className="memory-metric-label">
                {t.status.memoryPeakLabel}
              </span>
              <span className="memory-metric-value">
                {formatMemoryMb(status.memoryPeakRssBytes)}
              </span>
            </div>
            <div className="memory-metric-card">
              <span className="memory-metric-label">
                {t.status.memoryHeapLabel}
              </span>
              <span className="memory-metric-value">
                {formatMemoryMb(status.memoryHeapUsedBytes)}
              </span>
            </div>
          </div>
          <div className="memory-bar-section">
            <div className="memory-bar-track" aria-hidden="true">
              <div
                className="memory-seg-proc"
                style={{ width: `${memoryProcessBarWidth.toFixed(2)}%` }}
              />
              <div
                className="memory-seg-other"
                style={{ width: `${memoryOtherBarWidth.toFixed(2)}%` }}
              />
              {memoryTotalUsedBytes > 0
                ? <div className="memory-seg-total-cap" />
                : null}
            </div>
            <div className="memory-legend-grid">
              <div className="memory-legend-item">
                <span className="memory-dot proc" aria-hidden="true" />
                <span className="memory-legend-label">
                  {t.status.memoryProcessUsedLabel}
                </span>
                <span className="memory-legend-val proc">
                  {formatMemoryMb(status.memoryCurrentRssBytes)} (
                  {memoryProcessPercent.toFixed(1)}%)
                </span>
              </div>
              <div className="memory-legend-item">
                <span className="memory-dot other" aria-hidden="true" />
                <span className="memory-legend-label">
                  {t.status.memoryOtherUsedLabel}
                </span>
                <span className="memory-legend-val other">
                  {formatMemoryMb(status.memoryOtherBytes)} (
                  {memoryOtherPercent.toFixed(1)}%)
                </span>
              </div>
              <div className="memory-legend-item">
                <span className="memory-dot total" aria-hidden="true" />
                <span className="memory-legend-label">
                  {t.status.memoryTotalUsedLabel}
                </span>
                <span className="memory-legend-val total">
                  {formatMemoryMb(memoryTotalUsedBytes)} /{" "}
                  {formatMemoryMb(status.memoryTotalBytes)} (
                  {memoryTotalUsedPercent.toFixed(1)}%)
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const StatusOverviewCard: React.MemoExoticComponent<
  typeof StatusOverviewCardView
> = memo(StatusOverviewCardView);
