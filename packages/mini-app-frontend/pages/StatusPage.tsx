import { Fragment, useCallback, useEffect, useRef } from "react";
import type React from "react";
import type { ViewportAnchorScroll } from "../components/animations/expandFollowScroll";
import { CapabilityBlock } from "../components/CapabilityBlock";
import { StatusSkeleton } from "../components/skeletons/StatusSkeleton";
import { StatusOverviewCard } from "../components/StatusOverviewCard";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { formatClockTime } from "../libs/formatters";
import { RefreshSvgIcon, StatusSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createStatusStore } from "../store/status";
import type { MiniAppStatusStoreState } from "../store/status";
import type {
  MiniAppCapabilityStatus,
  MiniAppLanguage,
  MiniAppStatusView,
} from "../types/miniApp";

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
  /** 跨子系统面板共享的跟滚槽位。 */
  readonly followScrollSlotRef: React.RefObject<ViewportAnchorScroll | null>;
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
  followScrollSlotRef,
}: RenderStatusSnapshotOptions): React.JSX.Element {
  return (
    <Fragment>
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
                  followScrollSlotRef={followScrollSlotRef}
                />
              );
            }
          )}
        </div>
      </div>
    </Fragment>
  );
}

/**
 * 首页实时状态看板页面组件（前台时按状态仓库的轮询节奏刷新进程资源、会话、Telegram 出站与模型就绪状态）。
 *
 * @returns React 节点
 */
export function StatusPage(): React.JSX.Element {
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

  const followScrollSlotRef: React.RefObject<ViewportAnchorScroll | null> =
    useRef<ViewportAnchorScroll | null>(null);

  const handleSwitchMood: () => void = useCallback((): void => {
    void switchMood();
  }, [switchMood]);

  useEffect((): (() => void) => {
    void loadMood();
    startPolling();
    return (): void => {
      stopPolling();
    };
  }, [loadMood, startPolling, stopPolling]);

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <StatusSvgIcon size={16} className="pulse-icon" />
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
              followScrollSlotRef,
            })}
          </div>
        )
        : null}
    </section>
  );
}
