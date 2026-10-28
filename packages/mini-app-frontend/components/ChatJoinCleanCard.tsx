import type React from "react";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_PRESET_HOURS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { RefreshSvgIcon, TrashSvgIcon, UserSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppChatsStoreState } from "../store/chats";
import type { MiniAppChatDetail, MiniAppLanguage } from "../types/miniApp";
import { LoadingDotsWave } from "./animations/LoadingDotsWave";
import { useAnimatedRangeProgress } from "./animations/useAnimatedRangeProgress";
import type { AnimatedRangeProgressResult } from "./animations/useAnimatedRangeProgress";

/** `ChatJoinCleanCard` 组件属性参数。 */
export interface ChatJoinCleanCardProps {
  /** 当前群详情快照。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
  /** 群列表与详情状态仓库快照。 */
  readonly state: MiniAppChatsStoreState;
}

/**
 * 渲染群详情页中的「进群统计与批量清理」卡片（含小时滑杆、步进器、快捷预设按钮与三圆点波浪加载动效）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function ChatJoinCleanCard({
  chatDetail,
  state,
}: ChatJoinCleanCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (uiState: MiniAppUiStoreState): MiniAppLanguage => uiState.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    batchKickHours,
    loadingWindowJoined,
    batchKickSubmitting,
    setBatchKickHours,
    runBatchKick,
  }: MiniAppChatsStoreState = state;
  const {
    displayValue,
    isAnimating,
    animationPhase,
    progressPercent,
    onManualDragChange,
    onButtonStepChange,
  }: AnimatedRangeProgressResult = useAnimatedRangeProgress(
    batchKickHours,
    setBatchKickHours
  );
  const animClassSuffix: string = isAnimating
    ? `is-animating is-animating-${animationPhase}`
    : "";

  return (
    <div className="card join-clean-card">
      <div className="card-title">
        <span>{t.chats.joinCleanSectionTitle}</span>
        {chatDetail.batchKickRunning
          ? <span className="badge warn">{t.chats.batchKickRunningBadge}</span>
          : null}
      </div>
      <div className="join-clean-stat-box">
        <div className="join-clean-stat-main">
          <div className="join-clean-stat-label">
            <UserSvgIcon size={14} />
            <span>{t.chats.windowJoinedLabel}</span>
          </div>
          <div className="join-clean-stat-sub">
            {t.chats.windowJoinedSub(batchKickHours)}
          </div>
        </div>
        <div
          className={`join-clean-stat-value ${loadingWindowJoined ? "is-loading" : ""}`}
          aria-busy={loadingWindowJoined}
        >
          {loadingWindowJoined
            ? <LoadingDotsWave />
            : t.chats.windowJoinedValue(
              chatDetail.joinedCountsByHour[batchKickHours - 1] ?? 0
            )}
        </div>
      </div>
      <div className="join-clean-control-box">
        <div className="join-clean-window-head">
          <span className="join-clean-window-label">{t.chats.batchKickWindowLabel}</span>
          <div className="join-clean-stepper">
            <button
              type="button"
              className="join-clean-step-btn"
              aria-label={t.chats.batchKickDecreaseAria}
              disabled={
                batchKickSubmitting ||
                chatDetail.batchKickRunning ||
                batchKickHours <= MINI_APP_BATCH_KICK_MIN_HOURS
              }
              onClick={(): void => {
                onButtonStepChange(batchKickHours - 1);
              }}
            >
              −
            </button>
            <span className={`join-clean-hour-pill ${animClassSuffix}`}>
              {t.chats.batchKickHourPill(batchKickHours)}
            </span>
            <button
              type="button"
              className="join-clean-step-btn"
              aria-label={t.chats.batchKickIncreaseAria}
              disabled={
                batchKickSubmitting ||
                chatDetail.batchKickRunning ||
                batchKickHours >= MINI_APP_BATCH_KICK_MAX_HOURS
              }
              onClick={(): void => {
                onButtonStepChange(batchKickHours + 1);
              }}
            >
              +
            </button>
          </div>
        </div>
        <input
          type="range"
          className={`join-clean-range ${animClassSuffix}`}
          min={MINI_APP_BATCH_KICK_MIN_HOURS}
          max={MINI_APP_BATCH_KICK_MAX_HOURS}
          step="any"
          value={displayValue}
          style={{
            "--range-progress": progressPercent,
          } as React.CSSProperties}
          aria-label={t.chats.batchKickWindowLabel}
          disabled={batchKickSubmitting || chatDetail.batchKickRunning}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
            const rawValue: string = (
              event.currentTarget as unknown as { readonly value: string }
            ).value;
            onManualDragChange(Number(rawValue));
          }}
        />
        <div className="join-clean-presets">
          {MINI_APP_BATCH_KICK_PRESET_HOURS.map((preset: number): React.JSX.Element => (
            <button
              key={preset}
              type="button"
              className={`join-clean-preset-btn ${batchKickHours === preset ? "active" : ""}`}
              disabled={batchKickSubmitting || chatDetail.batchKickRunning}
              onClick={(): void => {
                onButtonStepChange(preset);
              }}
            >
              {`${preset}h`}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn danger icon-btn join-clean-trigger-btn"
          disabled={batchKickSubmitting || chatDetail.batchKickRunning}
          onClick={(): void => {
            void runBatchKick();
          }}
        >
          {batchKickSubmitting || chatDetail.batchKickRunning
            ? <RefreshSvgIcon size={14} className="spin-icon" />
            : <TrashSvgIcon size={14} />}
          <span>
            {batchKickSubmitting || chatDetail.batchKickRunning
              ? t.chats.batchKickRunningButton
              : t.chats.batchKickTriggerButton(batchKickHours)}
          </span>
        </button>
        {!chatDetail.batchKickRunning && chatDetail.lastBatchKickCompletion !== null
          ? (
            <div className="join-clean-result-box">
              {t.chats.batchKickCompletedSummary(
                chatDetail.lastBatchKickCompletion
              )}
            </div>
          )
          : null}
      </div>
    </div>
  );
}
