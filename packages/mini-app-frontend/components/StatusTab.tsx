import { useEffect, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  formatMemoryMb,
  formatTime,
  formatUptime,
} from "../libs/formatters";
import {
  ChevronDownSvgIcon,
  RefreshSvgIcon,
  StatusSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createStatusStore } from "../store/status";
import type { MiniAppStatusStoreState } from "../store/status";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppLanguage,
  MiniAppStatusView,
} from "../types/miniApp";
import { StatusSkeleton } from "./skeletons/StatusSkeleton";

/** `renderStatusSnapshot` 渲染函数的参数。 */
interface RenderStatusSnapshotOptions {
  /** 实时运行状态快照。 */
  readonly status: Readonly<MiniAppStatusView>;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 各子系统折叠面板的展开状态表（默认全部收起）。 */
  readonly expandedCapKeys: Readonly<Record<string, boolean>>;
  /** 切换指定子系统面板展开/收起的回调。 */
  readonly onToggleCapability: (capKey: string) => void;
  /** 当前全局生效的 AI 情绪名（未激活或不可用时为 `null`）。 */
  readonly currentMood: string | null;
  /** 是否正在请求切换全局 AI 情绪。 */
  readonly switchingMood: boolean;
  /** 点击「切换情绪」按钮的回调。 */
  readonly onSwitchMood: () => void;
}

/** 支持读取内容总高度的折叠面板 DOM 节点最小类型接口。 */
interface MeasurableCollapseElement {
  /** 元素内容的完整像素高度（不受外层 `height: 0` 裁切影响）。 */
  readonly scrollHeight?: number;
}

/** `CapabilityCollapseBody` 折叠动画容器的属性参数。 */
interface CapabilityCollapseBodyProps {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 面板内部渲染内容。 */
  readonly children: React.ReactNode;
}

/**
 * 基于真实像素高度（`0px <-> scrollHeight`）平滑过渡的子系统折叠面板容器。
 *
 * @param props 展开状态与子节点
 * @returns React 节点
 */
function CapabilityCollapseBody({
  expanded,
  children,
}: CapabilityCollapseBodyProps): React.JSX.Element {
  const bodyRef: React.RefObject<MeasurableCollapseElement | null> =
    useRef<MeasurableCollapseElement | null>(null);
  const [measuredHeight, setMeasuredHeight]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(0);

  useEffect((): void => {
    const nextHeight: number = bodyRef.current?.scrollHeight ?? 0;
    if (nextHeight > 0 && nextHeight !== measuredHeight) {
      setMeasuredHeight(nextHeight);
    }
  });

  const liveHeight: number = bodyRef.current?.scrollHeight ?? measuredHeight;
  const targetHeightCss: string =
    expanded ? (liveHeight > 0 ? `${liveHeight}px` : "auto") : "0px";

  return (
    <div
      className={`cap-collapse-wrap ${expanded ? "expanded" : ""}`}
      style={{ height: targetHeightCss }}
      aria-hidden={!expanded}
    >
      <div
        ref={(el: MeasurableCollapseElement | null): void => {
          bodyRef.current = el;
          const h: number = el?.scrollHeight ?? 0;
          if (h > 0 && h !== measuredHeight) {
            setMeasuredHeight(h);
          }
        }}
        className="cap-body"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 渲染已加载完成的实时状态卡片与可折叠子系统就绪看板。
 *
 * @param options 状态快照、翻译字典、折叠状态与情绪切换参数
 * @returns React 节点
 */
function renderStatusSnapshot({
  status,
  t,
  expandedCapKeys,
  onToggleCapability,
  currentMood,
  switchingMood,
  onSwitchMood,
}: RenderStatusSnapshotOptions): React.JSX.Element {
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
            (capability: Readonly<MiniAppCapabilityStatus>): React.JSX.Element => {
              const isExpanded: boolean = expandedCapKeys[capability.key] === true;
              const isMoodCap: boolean = capability.key === "mood";
              return (
                <div
                  key={capability.key}
                  className={`cap-block ${isExpanded ? "expanded" : ""}`}
                >
                  <button
                    type="button"
                    className="cap-header-btn"
                    aria-expanded={isExpanded}
                    onClick={(): void => {
                      onToggleCapability(capability.key);
                    }}
                  >
                    <div className="cap-header-main">
                      <span
                        className={`cap-status-dot ${capability.ready ? "ok" : "warn"}`}
                        aria-hidden="true"
                      />
                      <span className="cap-title">
                        {t.status.capabilityLabel(capability)}
                      </span>
                      {isMoodCap && currentMood !== null
                        ? (
                          <span className="cap-summary-pill mood-pill">
                            {currentMood}
                          </span>
                        )
                        : capability.ready && capability.items.length > 0
                          ? (
                            <span className="cap-summary-pill">
                              {t.status.capabilityItemCount(capability.items.length)}
                            </span>
                          )
                          : null}
                    </div>
                    <div className="cap-header-right">
                      <span className={`badge ${capability.ready ? "ok" : "warn"}`}>
                        {capability.ready
                          ? t.status.capabilityReadyBadge
                          : t.status.capabilityMissingBadge}
                      </span>
                      <span
                        className={`cap-chevron-pill ${isExpanded ? "expanded" : ""}`}
                        aria-hidden="true"
                      >
                        <ChevronDownSvgIcon
                          size={14}
                          className={`chevron-icon ${isExpanded ? "rotated" : ""}`}
                        />
                      </span>
                    </div>
                  </button>
                  <CapabilityCollapseBody expanded={isExpanded}>
                    {isMoodCap
                      ? (
                        <div className="mood-current-panel">
                          <div className="mood-current-info">
                            <span className="mood-current-label">
                              {t.status.moodCurrentLabel}
                            </span>
                            <div className="mood-current-val-row">
                              <span
                                className={`mood-live-dot ${currentMood !== null ? "active" : ""}`}
                                aria-hidden="true"
                              />
                              <span className="mood-current-name">
                                {currentMood ?? t.status.moodUnavailableText}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn primary mood-switch-btn"
                            disabled={switchingMood || !capability.ready}
                            onClick={onSwitchMood}
                          >
                            <RefreshSvgIcon
                              size={13}
                              className={switchingMood ? "spin-icon" : ""}
                            />
                            <span>
                              {switchingMood
                                ? t.status.moodSwitchingButton
                                : t.status.moodSwitchButton}
                            </span>
                          </button>
                        </div>
                      )
                      : null}
                    <div className={`cap-items ${isMoodCap ? "mood-pool-grid" : ""}`}>
                      {capability.items.length > 0
                        ? capability.items.map(
                          (
                            item: Readonly<MiniAppCapabilityDetailItem>,
                            idx: number
                          ): React.JSX.Element => {
                            const displayItem: Readonly<MiniAppCapabilityDetailItem> =
                              t.status.capabilityItem(item);
                            const isActiveMood: boolean =
                              isMoodCap &&
                              currentMood !== null &&
                              item.label === currentMood;
                            return (
                              <div
                                key={`${item.label}-${idx}`}
                                className={`cap-item ${isActiveMood ? "active-mood" : ""}`}
                              >
                                <div className="cap-item-top">
                                  <span className="cap-tag">{displayItem.label}</span>
                                  {isActiveMood
                                    ? (
                                      <span className="cap-active-pill">
                                        {t.status.moodCurrentActiveBadge}
                                      </span>
                                    )
                                    : displayItem.sub !== undefined
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
                  </CapabilityCollapseBody>
                </div>
              );
            }
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 首页实时状态看板组件（每 3 秒自动刷新一次进程资源、会话、Telegram 出站与模型就绪状态）。
 *
 * @returns React 节点
 */
export function StatusTab(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    status,
    loading,
    refreshing,
    errorText,
    expandedCapKeys,
    currentMood,
    switchingMood,
    loadMood,
    loadStatus,
    toggleCapability,
    switchMood,
  }: MiniAppStatusStoreState = useComponentStore(createStatusStore);

  useEffect((): (() => void) => {
    void loadStatus(false);
    void loadMood();
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      void loadStatus(false);
    }, MINI_APP_STATUS_POLL_INTERVAL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [loadMood, loadStatus]);

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <StatusSvgIcon size={15} className="pulse-icon" />
          </span>
          <span>
            {!loading && !refreshing && status !== null
              ? t.status.updatedAtSub(formatTime(status.generatedAt))
              : t.status.loadingText}
          </span>
        </span>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loading || refreshing}
          onClick={(): void => {
            void loadStatus(true);
          }}
        >
          <RefreshSvgIcon
            size={14}
            className={loading || refreshing ? "spin-icon" : ""}
          />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {loading || refreshing ? <StatusSkeleton /> : null}

      {!loading && !refreshing && errorText !== null && status === null
        ? (
          <div className="card">
            <div className="empty danger-text">{errorText}</div>
          </div>
        )
        : null}

      {!loading && !refreshing && status !== null
        ? (
          <div className="animate-fade-in">
            {renderStatusSnapshot({
              status,
              t,
              expandedCapKeys,
              onToggleCapability: toggleCapability,
              currentMood,
              switchingMood,
              onSwitchMood: (): void => {
                void switchMood();
              },
            })}
          </div>
        )
        : null}
    </section>
  );
}
