import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../../../consts/miniApp";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppLanguage,
  MiniAppMoodMutationResult,
  MiniAppMoodView,
  MiniAppStatusView,
} from "../../../types/miniApp";
import {
  ChevronDownSvgIcon,
  RefreshSvgIcon,
  StatusSvgIcon,
} from "../../miniAppResoures";
import {
  fetchMiniAppMood,
  fetchMiniAppStatus,
  switchMiniAppMood,
} from "../api";
import {
  formatMemoryMb,
  formatTime,
  formatUptime,
  waitMinimumLoadingDuration,
} from "../formatters";
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

/** `renderStatusSnapshot` 渲染函数的参数。 */
export interface RenderStatusSnapshotOptions {
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

const SKELETON_CAPABILITY_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5];
const SKELETON_MEMORY_INDICES: readonly number[] = [0, 1, 2];

/**
 * 渲染实时状态页专属骨架屏（1:1 对应顶部 5 项指标卡、CPU 环形图、全宽三栏内存进度卡与 6 项默认收起的能力折叠行）。
 *
 * @returns React 节点
 */
function renderStatusSkeleton(): React.JSX.Element {
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
              {SKELETON_MEMORY_INDICES.map(
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
                {SKELETON_MEMORY_INDICES.map(
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
          {SKELETON_CAPABILITY_INDICES.map(
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
  ] = useState<boolean>(true);
  const [refreshing, setRefreshing]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [errorText, setErrorText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [expandedCapKeys, setExpandedCapKeys]: [
    Readonly<Record<string, boolean>>,
    React.Dispatch<React.SetStateAction<Readonly<Record<string, boolean>>>>
  ] = useState<Readonly<Record<string, boolean>>>({});
  const [currentMood, setCurrentMood]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);
  const [switchingMood, setSwitchingMood]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const hasSnapshotRef: React.RefObject<boolean> = useRef<boolean>(false);
  const requestSeqRef: React.RefObject<number> = useRef<number>(0);

  const loadMood: () => Promise<void> = useCallback(async (): Promise<void> => {
    try {
      const moodView: MiniAppMoodView = await fetchMiniAppMood();
      if (moodView.available && moodView.currentMood !== null) {
        setCurrentMood(moodView.currentMood);
      } else {
        setCurrentMood(null);
      }
    } catch (_error: unknown) {
      // 情绪查询异常不阻塞主状态看板
    }
  }, []);

  const loadStatus: (showErrorToast: boolean) => Promise<void> = useCallback(
    async (showErrorToast: boolean): Promise<void> => {
      const reqId: number = ++requestSeqRef.current;
      const startedAt: number = Date.now();
      const shouldWaitMin: boolean = showErrorToast || !hasSnapshotRef.current;
      if (showErrorToast) {
        setRefreshing(true);
        void loadMood();
      }
      try {
        const next: MiniAppStatusView = await fetchMiniAppStatus();
        if (shouldWaitMin) {
          await waitMinimumLoadingDuration(startedAt);
        }
        if (reqId !== requestSeqRef.current) {
          return;
        }
        hasSnapshotRef.current = true;
        setStatus(next);
        setErrorText(null);
        onStatusLoaded(next);
      } catch (error: unknown) {
        if (shouldWaitMin) {
          await waitMinimumLoadingDuration(startedAt);
        }
        if (reqId !== requestSeqRef.current) {
          return;
        }
        const message: string = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        if (showErrorToast) {
          onToast(message);
        }
      } finally {
        if (reqId === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [loadMood, onStatusLoaded, onToast]
  );

  const handleToggleCapability: (capKey: string) => void = useCallback(
    (capKey: string): void => {
      setExpandedCapKeys(
        (prev: Readonly<Record<string, boolean>>): Readonly<Record<string, boolean>> => ({
          ...prev,
          [capKey]: prev[capKey] !== true,
        })
      );
    },
    []
  );

  const handleSwitchMood: () => Promise<void> = useCallback(async (): Promise<void> => {
    setSwitchingMood(true);
    try {
      const result: MiniAppMoodMutationResult = await switchMiniAppMood();
      if (result.ok && result.currentMood !== null) {
        setCurrentMood(result.currentMood);
      }
      onToast(result.message);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setSwitchingMood(false);
    }
  }, [onToast]);

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

      {loading || refreshing ? renderStatusSkeleton() : null}

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
              onToggleCapability: handleToggleCapability,
              currentMood,
              switchingMood,
              onSwitchMood: (): void => {
                void handleSwitchMood();
              },
            })}
          </div>
        )
        : null}
    </section>
  );
}
