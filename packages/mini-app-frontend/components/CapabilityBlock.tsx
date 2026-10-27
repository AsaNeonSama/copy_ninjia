import { memo } from "react";
import type React from "react";
import type { MiniAppTranslations } from "../i18n";
import { areCapabilityStatusEqual } from "../libs/formatters";
import { ChevronDownSvgIcon } from "../resource";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
} from "../types/miniApp";
import { CapabilityCollapseBody } from "./animations/CapabilityCollapseBody";
import type { ExpandScrollScheduleState } from "./animations/CapabilityCollapseBody";
import { LoadingDotsWave } from "./animations/LoadingDotsWave";

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
              size={14}
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
                className={`btn primary mood-switch-btn ${switchingMood ? "is-loading" : ""}`}
                disabled={switchingMood || !capability.ready}
                aria-busy={switchingMood}
                onClick={onSwitchMood}
              >
                {switchingMood
                  ? <LoadingDotsWave />
                  : <span>{t.status.moodSwitchButton}</span>}
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

export const CapabilityBlock: React.MemoExoticComponent<
  typeof CapabilityBlockView
> = memo(CapabilityBlockView, areCapabilityBlockPropsEqual);
