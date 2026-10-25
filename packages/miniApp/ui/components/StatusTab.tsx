import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../../../consts/miniApp";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppLanguage,
  MiniAppStatusView,
} from "../../../types/miniApp";
import { RefreshSvgIcon, StatusSvgIcon } from "../../miniAppResoures";
import { fetchMiniAppStatus } from "../api";
import { formatMemoryMb, formatTime, formatUptime } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";

/** `StatusTab` 组件的属性参数。 */
export interface StatusTabProps {
  /** 顶层鉴权门禁阶段已预拉取的初始状态快照。 */
  readonly initialStatus?: MiniAppStatusView | null;
  /** 当成功获取状态快照时同步通知顶层状态栏。 */
  readonly onStatusLoaded: (status: MiniAppStatusView) => void;
  /** 全局错误/操作提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * 渲染已加载完成的实时状态卡片与子系统就绪看板。
 *
 * @param status 实时运行状态快照
 * @param t 当前语言翻译字典
 * @returns React 节点
 */
function renderStatusSnapshot(
  status: Readonly<MiniAppStatusView>,
  t: Readonly<MiniAppTranslations>
): React.JSX.Element {
  const cpuClampedPercent: number = Math.min(
    100,
    Math.max(
      0,
      Number.isFinite(status.cpuAveragePercent) ? status.cpuAveragePercent : 0
    )
  );
  const cpuRingCircumference: number = 109.96;
  const cpuRingOffset: string = (
    cpuRingCircumference *
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
  return (
    <>
      <div className="card">
        <div className="card-title">
          <span>{t.tabs.status}</span>
          <span className="badge ok">
            {t.status.updatedAtSub(formatTime(status.generatedAt))}
          </span>
        </div>
        <div className="grid-2">
          <div className="stat-box">
            <div className="stat-label">{t.status.uptimeLabel}</div>
            <div className="stat-value">{formatUptime(status.uptimeMs)}</div>
            <div className="stat-sub">
              {t.status.updatedAtSub(formatTime(status.generatedAt))}
            </div>
          </div>
          <div className="stat-box stat-box-cpu">
            <div className="stat-cpu-row">
              <div className="stat-cpu-main">
                <div className="stat-label">{t.status.cpuLoadLabel}</div>
                <div className="stat-value">
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
                    strokeDasharray="109.96"
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
            <div className="stat-value">{status.managedChatCount}</div>
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
            <div className="stat-value">
              {status.activeSessions.total}
            </div>
            <div className="stat-sub">
              {t.status.activeSessionsSub(status.activeSessions)}
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
              {status.telegramOutbound.inFlight} /{" "}
              {status.telegramOutbound.maxConcurrency}
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

      <div className="card">
        <div className="card-title">
          <span>{t.status.capabilitiesSectionTitle}</span>
        </div>
        <div className="cap-list">
          {status.capabilities.map(
            (capability: Readonly<MiniAppCapabilityStatus>): React.JSX.Element => (
              <div key={capability.key} className="cap-block">
                <div className="cap-header">
                  <span className="cap-title">
                    {t.status.capabilityLabel(capability)}
                  </span>
                  <span className={`badge ${capability.ready ? "ok" : "warn"}`}>
                    {capability.ready
                      ? t.status.capabilityReadyBadge
                      : t.status.capabilityMissingBadge}
                  </span>
                </div>
                <div className="cap-items">
                  {capability.items.length > 0
                    ? capability.items.map(
                      (
                        item: Readonly<MiniAppCapabilityDetailItem>,
                        idx: number
                      ): React.JSX.Element => {
                        const displayItem: Readonly<MiniAppCapabilityDetailItem> =
                          t.status.capabilityItem(item);
                        return (
                          <div key={`${item.label}-${idx}`} className="cap-item">
                            <div className="cap-item-top">
                              <span className="cap-tag">{displayItem.label}</span>
                              {displayItem.sub !== undefined
                                ? <span className="cap-sub">{displayItem.sub}</span>
                                : null}
                            </div>
                            <div className="cap-val">{displayItem.value}</div>
                          </div>
                        );
                      }
                    )
                    : (
                      <div className="cap-item">
                        <div className="cap-val">{capability.detail}</div>
                      </div>
                    )}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 首页实时状态看板组件（每 3 秒自动刷新一次进程资源、会话、Telegram 出站与模型就绪状态）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function StatusTab({
  initialStatus = null,
  onStatusLoaded,
  onToast,
}: StatusTabProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [status, setStatus]: [
    MiniAppStatusView | null,
    React.Dispatch<React.SetStateAction<MiniAppStatusView | null>>
  ] = useState<MiniAppStatusView | null>(initialStatus);
  const [loading, setLoading]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(initialStatus === null);
  const [refreshing, setRefreshing]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [errorText, setErrorText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);

  const loadStatus: (showErrorToast: boolean) => Promise<void> = useCallback(
    async (showErrorToast: boolean): Promise<void> => {
      if (showErrorToast) {
        setRefreshing(true);
      }
      try {
        const next: MiniAppStatusView = await fetchMiniAppStatus();
        setStatus(next);
        setErrorText(null);
        onStatusLoaded(next);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        if (showErrorToast) {
          onToast(message);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onStatusLoaded, onToast]
  );

  useEffect((): (() => void) => {
    void loadStatus(false);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      void loadStatus(false);
    }, MINI_APP_STATUS_POLL_INTERVAL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [loadStatus]);

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <StatusSvgIcon size={15} className="pulse-icon" />
          </span>
          <span>
            {status !== null
              ? t.status.updatedAtSub(formatTime(status.generatedAt))
              : t.status.loadingText}
          </span>
        </span>
        <button
          type="button"
          className="btn icon-btn"
          disabled={refreshing}
          onClick={(): void => {
            void loadStatus(true);
          }}
        >
          <RefreshSvgIcon size={14} className={refreshing ? "spin-icon" : ""} />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {loading && status === null
        ? (
          <div className="card loading-box">
            <div className="spinner-ring" />
            <div className="loading-text">{t.status.loadingText}</div>
            <div className="skeleton-grid">
              <div className="skeleton-card"><div className="skeleton-line medium" /><div className="skeleton-line wide" /></div>
              <div className="skeleton-card"><div className="skeleton-line medium" /><div className="skeleton-line wide" /></div>
              <div className="skeleton-card"><div className="skeleton-line medium" /><div className="skeleton-line wide" /></div>
              <div className="skeleton-card"><div className="skeleton-line medium" /><div className="skeleton-line wide" /></div>
            </div>
          </div>
        )
        : null}

      {errorText !== null && status === null
        ? (
          <div className="card">
            <div className="empty danger-text">{errorText}</div>
          </div>
        )
        : null}

      {status !== null ? renderStatusSnapshot(status, t) : null}
    </section>
  );
}
