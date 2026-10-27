import { memo, useCallback, useEffect, useRef } from "react";
import type React from "react";
import {
  MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX,
  MINI_APP_CAP_SCROLL_BOTTOM_MARGIN_PX,
  MINI_APP_CAP_SCROLL_COMFORT_BODY_FACTOR,
  MINI_APP_CAP_SCROLL_COMFORT_TOP_RATIO,
  MINI_APP_CAP_SCROLL_MIN_DELTA_PX,
  MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS,
  MINI_APP_CAP_SCROLL_TOP_MARGIN_PX,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  areCapabilityStatusEqual,
  computeCapabilityCollapseDurationMs,
  formatClockTime,
  formatMemoryMb,
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

/** 子系统面板展开后延迟视口跟滚的共享调度状态（保证连续展开多项时只触发最后一次滑动）。 */
export interface ExpandScrollScheduleState {
  /** 当前挂起的延迟滚动定时器句柄（无挂起任务时为 `null`）。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 当前批次所有正在展开面板中最晚完成展开动画的时间戳（`performance.now()` 毫秒）。 */
  latestFinishTimeMs: number;
}

/** `StatusOverviewCard` 顶部资源概览卡片的属性参数。 */
interface StatusOverviewCardProps {
  /** 实时运行状态快照。 */
  readonly status: Readonly<MiniAppStatusView>;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/** `CapabilityBlock` 单个子系统折叠项组件的属性参数。 */
export interface CapabilityBlockProps {
  /** 单个子系统配置与就绪状态。 */
  readonly capability: Readonly<MiniAppCapabilityStatus>;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 当前子系统面板是否处于展开状态。 */
  readonly isExpanded: boolean;
  /** 切换指定子系统面板展开/收起的回调。 */
  readonly onToggleCapability: (capKey: string) => void;
  /** 当前全局生效的 AI 情绪名（非 `mood` 项固定传 `null`）。 */
  readonly currentMood: string | null;
  /** 是否正在请求切换全局 AI 情绪（非 `mood` 项固定传 `false`）。 */
  readonly switchingMood: boolean;
  /** 点击「切换情绪」按钮的回调。 */
  readonly onSwitchMood: () => void;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
}

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
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
}

/** 支持读取内容总高度的折叠面板内容 DOM 节点最小类型接口。 */
interface MeasurableCollapseElement {
  /** 元素包含边框与内边距的完整布局像素高度。 */
  readonly offsetHeight?: number;
  /** 元素内容的完整像素高度（不受外层 `height: 0` 裁切影响）。 */
  readonly scrollHeight?: number;
}

/** 支持直接写入行内高度与过渡时长样式的折叠外层容器 DOM 节点最小类型接口。 */
interface MeasurableCollapseWrapElement {
  /** 行内样式对象。 */
  readonly style?: {
    height: string;
    setProperty?: (property: string, value: string) => void;
  };
  /** 读取元素相对于视口的几何边界。 */
  readonly getBoundingClientRect?: () => {
    readonly top: number;
    readonly height: number;
  };
}

/** 支持读取视口尺寸与触发平滑滚动的全局宿主最小类型接口。 */
interface ScrollableViewportHost {
  /** 视口可视像素高度。 */
  readonly innerHeight?: number;
  /** 按指定增量平滑滚动文档视口。 */
  readonly scrollBy?: (options: {
    readonly top: number;
    readonly behavior: "smooth";
  }) => void;
}

/** `CapabilityCollapseBody` 折叠动画容器的属性参数。 */
interface CapabilityCollapseBodyProps {
  /** 当前面板是否处于展开状态。 */
  readonly expanded: boolean;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
  /** 面板内部渲染内容。 */
  readonly children: React.ReactNode;
}

/** `scrollViewportAfterCapabilityExpanded` 展开后延迟跟滚的参数。 */
interface ScrollViewportAfterExpandedOptions {
  /** 折叠外层容器节点。 */
  readonly wrapEl: MeasurableCollapseWrapElement;
  /** 展开内容的像素高度。 */
  readonly bodyHeight: number;
  /** 面板展开过渡时长（毫秒）。 */
  readonly durationMs: number;
  /** 跨子系统面板共享的展开跟滚定时器状态引用。 */
  readonly expandScrollStateRef: React.RefObject<ExpandScrollScheduleState>;
}

/** 折叠容器带自定义动画时长 CSS 变量的行内样式类型。 */
type CollapseWrapInlineStyle = React.CSSProperties & {
  readonly "--cap-duration": string;
};

/**
 * 读取折叠面板内容节点的完整像素高度（优先取含上边框的 `offsetHeight`）。
 *
 * @param element 折叠面板内容 DOM 节点
 * @returns 像素高度（未挂载时返回 `0`）
 */
function readCollapseBodyHeight(
  element: MeasurableCollapseElement | null
): number {
  if (element === null) return 0;
  const offset: number = element.offsetHeight ?? 0;
  if (offset > 0) return offset;
  return element.scrollHeight ?? 0;
}

/**
 * 在子系统折叠面板展开动画完成后触发浏览器原生平滑向下滚动以展现展开内容。
 * 若在等待期间连续展开多个面板，自动取消前序未触发的滚动定时器并顺延至最晚完成的展开面板结束后单次滑动。
 *
 * @param options 折叠容器节点、内容高度、展开时长与共享调度状态引用
 * @returns 取消本次延迟滚动定时器的清理函数（无需滚动时返回 `undefined`）
 */
function scrollViewportAfterCapabilityExpanded({
  wrapEl,
  bodyHeight,
  durationMs,
  expandScrollStateRef,
}: ScrollViewportAfterExpandedOptions): (() => void) | undefined {
  const host: ScrollableViewportHost = globalThis as ScrollableViewportHost;
  const scrollByFn:
    | ((options: { readonly top: number; readonly behavior: "smooth" }) => void)
    | undefined = host.scrollBy;
  if (
    typeof scrollByFn !== "function" ||
    typeof wrapEl.getBoundingClientRect !== "function" ||
    bodyHeight <= 0
  ) {
    return undefined;
  }

  const scheduleState: ExpandScrollScheduleState = expandScrollStateRef.current;
  if (scheduleState.timer !== null) {
    clearTimeout(scheduleState.timer);
    scheduleState.timer = null;
  }
  const now: number = performance.now();
  const finishTimeMs: number = Math.max(
    scheduleState.latestFinishTimeMs,
    now + durationMs
  );
  scheduleState.latestFinishTimeMs = finishTimeMs;
  const waitMs: number =
    Math.max(durationMs, Math.ceil(finishTimeMs - now)) +
    MINI_APP_CAP_SCROLL_SETTLE_DELAY_MS;

  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    if (scheduleState.timer === timer) {
      scheduleState.timer = null;
    }
    const viewportHeight: number = host.innerHeight ?? 0;
    if (
      viewportHeight <= 0 ||
      typeof wrapEl.getBoundingClientRect !== "function"
    ) {
      return;
    }
    const wrapRect: { readonly top: number; readonly height: number } =
      wrapEl.getBoundingClientRect();
    const actualBodyHeight: number = Math.max(wrapRect.height, bodyHeight);
    const blockTop: number = wrapRect.top - MINI_APP_CAP_HEADER_ESTIMATED_HEIGHT_PX;
    const maxScrollKeepHeader: number = Math.max(
      0,
      blockTop - MINI_APP_CAP_SCROLL_TOP_MARGIN_PX
    );
    const expandedBottom: number = wrapRect.top + actualBodyHeight;
    const overflowBottom: number = Math.max(
      0,
      expandedBottom + MINI_APP_CAP_SCROLL_BOTTOM_MARGIN_PX - viewportHeight
    );
    const comfortTargetTop: number =
      viewportHeight * MINI_APP_CAP_SCROLL_COMFORT_TOP_RATIO;
    const comfortShift: number =
      blockTop > comfortTargetTop
        ? Math.min(
          actualBodyHeight * MINI_APP_CAP_SCROLL_COMFORT_BODY_FACTOR,
          blockTop - comfortTargetTop
        )
        : 0;
    const scrollDelta: number = Math.min(
      maxScrollKeepHeader,
      Math.max(overflowBottom, Math.round(comfortShift))
    );
    if (scrollDelta > MINI_APP_CAP_SCROLL_MIN_DELTA_PX) {
      scrollByFn.call(host, { top: scrollDelta, behavior: "smooth" });
    }
  }, waitMs);

  scheduleState.timer = timer;
  return (): void => {
    clearTimeout(timer);
    if (scheduleState.timer === timer) {
      scheduleState.timer = null;
    }
  };
}

/**
 * 基于真实像素高度与自适应过渡时长平滑展开/收起的子系统折叠面板容器。
 *
 * @param props 展开状态、共享滚动调度引用与子节点
 * @returns React 节点
 */
function CapabilityCollapseBody({
  expanded,
  expandScrollStateRef,
  children,
}: CapabilityCollapseBodyProps): React.JSX.Element {
  const wrapRef: React.RefObject<MeasurableCollapseWrapElement | null> =
    useRef<MeasurableCollapseWrapElement | null>(null);
  const bodyRef: React.RefObject<MeasurableCollapseElement | null> =
    useRef<MeasurableCollapseElement | null>(null);
  const lastHeightRef: React.RefObject<number> = useRef<number>(0);
  const prevExpandedRef: React.RefObject<boolean> = useRef<boolean>(expanded);

  const setWrapNode: (el: MeasurableCollapseWrapElement | null) => void =
    useCallback((el: MeasurableCollapseWrapElement | null): void => {
      wrapRef.current = el;
    }, []);
  const setBodyNode: (el: MeasurableCollapseElement | null) => void =
    useCallback((el: MeasurableCollapseElement | null): void => {
      bodyRef.current = el;
      const measured: number = readCollapseBodyHeight(el);
      if (measured > 0) {
        lastHeightRef.current = measured;
      }
    }, []);

  useEffect((): void => {
    const measured: number = readCollapseBodyHeight(bodyRef.current);
    if (measured > 0) {
      lastHeightRef.current = measured;
    }
    const wrapEl: MeasurableCollapseWrapElement | null = wrapRef.current;
    if (wrapEl?.style === undefined) return;
    const effectiveHeight: number =
      measured > 0 ? measured : lastHeightRef.current;
    const durationMs: number =
      computeCapabilityCollapseDurationMs(effectiveHeight);
    wrapEl.style.setProperty?.("--cap-duration", `${durationMs}ms`);
    if (expanded && measured > 0) {
      const nextHeightCss: string = `${measured}px`;
      if (wrapEl.style.height !== nextHeightCss) {
        wrapEl.style.height = nextHeightCss;
      }
    }
  }, [expanded, children]);

  useEffect((): (() => void) | undefined => {
    const wasExpanded: boolean = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    if (!wasExpanded && expanded) {
      const wrapEl: MeasurableCollapseWrapElement | null = wrapRef.current;
      const measured: number = readCollapseBodyHeight(bodyRef.current);
      const effectiveHeight: number =
        measured > 0 ? measured : lastHeightRef.current;
      if (wrapEl !== null && effectiveHeight > 0) {
        const durationMs: number =
          computeCapabilityCollapseDurationMs(effectiveHeight);
        return scrollViewportAfterCapabilityExpanded({
          wrapEl,
          bodyHeight: effectiveHeight,
          durationMs,
          expandScrollStateRef,
        });
      }
    }
    return undefined;
  }, [expanded, expandScrollStateRef]);

  const currentMeasured: number = readCollapseBodyHeight(bodyRef.current);
  const effectiveHeight: number =
    currentMeasured > 0 ? currentMeasured : lastHeightRef.current;
  const durationMs: number =
    computeCapabilityCollapseDurationMs(effectiveHeight);
  const targetHeightCss: string =
    expanded ? (effectiveHeight > 0 ? `${effectiveHeight}px` : "auto") : "0px";
  const wrapStyle: CollapseWrapInlineStyle = {
    height: targetHeightCss,
    "--cap-duration": `${durationMs}ms`,
  };

  return (
    <div
      ref={setWrapNode}
      className={`cap-collapse-wrap ${expanded ? "expanded" : ""}`}
      style={wrapStyle}
      aria-hidden={!expanded}
    >
      <div ref={setBodyNode} className="cap-body">
        {children}
      </div>
    </div>
  );
}

/**
 * 判断单个子系统折叠项组件的前后属性是否等价，避免 3 秒轮询或兄弟面板展开时触发重渲染与动画打断。
 *
 * @param prev 上一次渲染的属性
 * @param next 本次渲染的属性
 * @returns 属性等价无需重渲染时返回 `true`
 */
function areCapabilityBlockPropsEqual(
  prev: Readonly<CapabilityBlockProps>,
  next: Readonly<CapabilityBlockProps>
): boolean {
  return (
    prev.isExpanded === next.isExpanded &&
    prev.t === next.t &&
    prev.currentMood === next.currentMood &&
    prev.switchingMood === next.switchingMood &&
    prev.onToggleCapability === next.onToggleCapability &&
    prev.onSwitchMood === next.onSwitchMood &&
    prev.expandScrollStateRef === next.expandScrollStateRef &&
    areCapabilityStatusEqual(prev.capability, next.capability)
  );
}

/**
 * 渲染单个可折叠的子系统就绪度与配置明细面板。
 *
 * @param props 子系统状态、展开态、翻译字典与交互回调
 * @returns React 节点
 */
function CapabilityBlockView({
  capability,
  t,
  isExpanded,
  onToggleCapability,
  currentMood,
  switchingMood,
  onSwitchMood,
  expandScrollStateRef,
}: CapabilityBlockProps): React.JSX.Element {
  const isMoodCap: boolean = capability.key === "mood";
  return (
    <div className={`cap-block ${isExpanded ? "expanded" : ""}`}>
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
              size={15}
              className={`chevron-icon ${isExpanded ? "rotated" : ""}`}
            />
          </span>
        </div>
      </button>
      <CapabilityCollapseBody
        expanded={isExpanded}
        expandScrollStateRef={expandScrollStateRef}
      >
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

const CapabilityBlock: React.MemoExoticComponent<typeof CapabilityBlockView> =
  memo(CapabilityBlockView, areCapabilityBlockPropsEqual);

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
          <div className="stat-value">{formatUptime(status.uptimeMs)}</div>
          <div className="stat-sub">
            {updatedAtText}
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
  );
}

const StatusOverviewCard: React.MemoExoticComponent<typeof StatusOverviewCardView> =
  memo(StatusOverviewCardView);

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
  expandScrollStateRef,
}: RenderStatusSnapshotOptions): React.JSX.Element {
  return (
    <>
      <StatusOverviewCard status={status} t={t} />

      <div className="card">
        <div className="card-title">
          <span>{t.status.capabilitiesSectionTitle}</span>
        </div>
        <div className="cap-list">
          {status.capabilities.map(
            (capability: Readonly<MiniAppCapabilityStatus>): React.JSX.Element => {
              const isMoodCap: boolean = capability.key === "mood";
              return (
                <CapabilityBlock
                  key={capability.key}
                  capability={capability}
                  t={t}
                  isExpanded={expandedCapKeys[capability.key] === true}
                  onToggleCapability={onToggleCapability}
                  currentMood={isMoodCap ? currentMood : null}
                  switchingMood={isMoodCap ? switchingMood : false}
                  onSwitchMood={onSwitchMood}
                  expandScrollStateRef={expandScrollStateRef}
                />
              );
            }
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 首页实时状态看板组件（前台时按状态仓库的轮询节奏刷新进程资源、会话、Telegram 出站与模型就绪状态）。
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
    startPolling,
    stopPolling,
    toggleCapability,
    switchMood,
  }: MiniAppStatusStoreState = useComponentStore(createStatusStore);

  const expandScrollStateRef: React.RefObject<ExpandScrollScheduleState> =
    useRef<ExpandScrollScheduleState>({
      timer: null,
      latestFinishTimeMs: 0,
    });

  const handleSwitchMood: () => void = useCallback((): void => {
    void switchMood();
  }, [switchMood]);

  useEffect((): (() => void) => {
    void loadMood();
    startPolling();
    const scrollState: ExpandScrollScheduleState = expandScrollStateRef.current;
    return (): void => {
      stopPolling();
      if (scrollState.timer !== null) {
        clearTimeout(scrollState.timer);
        scrollState.timer = null;
      }
    };
  }, [loadMood, startPolling, stopPolling]);

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <StatusSvgIcon size={15} className="pulse-icon" />
          </span>
          <span>
            {!loading && !refreshing && status !== null
              ? t.status.updatedAtSub(formatClockTime(status.generatedAt))
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
              onSwitchMood: handleSwitchMood,
              expandScrollStateRef,
            })}
          </div>
        )
        : null}
    </section>
  );
}
