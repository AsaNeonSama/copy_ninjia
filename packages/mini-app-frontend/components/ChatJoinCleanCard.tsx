import { memo } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_PRESET_HOURS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { readEventTargetValue } from "../libs/formatters";
import { RefreshSvgIcon, TrashSvgIcon, UserSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppChatsStore, MiniAppChatsStoreState } from "../store/chats";
import type {
  MiniAppBatchKickCompletion,
  MiniAppChatDetail,
  MiniAppLanguage,
} from "../types/miniApp";
import { InlineNoticeCollapse } from "./animations/CollapseGrid";
import { LoadingDotsWave } from "./animations/LoadingDotsWave";
import { useAnimatedRangeProgress } from "./animations/useAnimatedRangeProgress";
import type { AnimatedRangeProgressResult } from "./animations/useAnimatedRangeProgress";

/** `ChatJoinCleanCard` 订阅的批量清理状态与动作切片。 */
type ChatJoinCleanCardSlice = Pick<
  MiniAppChatsStoreState,
  | "batchKickHours"
  | "loadingWindowJoined"
  | "batchKickSubmitting"
  | "setBatchKickHours"
  | "runBatchKick"
>;

/**
 * 从受管群状态仓库提取 `ChatJoinCleanCard` 所需的回溯清理字段。
 *
 * @param state 受管群完整状态快照
 * @returns `ChatJoinCleanCard` 订阅切片
 */
function selectChatJoinCleanCardState(
  state: MiniAppChatsStoreState
): ChatJoinCleanCardSlice {
  return {
    batchKickHours: state.batchKickHours,
    loadingWindowJoined: state.loadingWindowJoined,
    batchKickSubmitting: state.batchKickSubmitting,
    setBatchKickHours: state.setBatchKickHours,
    runBatchKick: state.runBatchKick,
  };
}

/** `ChatJoinCleanCard` 组件属性参数。 */
export interface ChatJoinCleanCardProps {
  /** 当前群详情快照。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
  /** `ChatsPage` 持有的受管群状态仓库实例。 */
  readonly store: MiniAppChatsStore;
}

/**
 * 渲染群详情页中的「进群统计与批量清理」卡片（含小时滑杆、步进器、快捷预设按钮与三枚方形加载块动效）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function ChatJoinCleanCardView({
  chatDetail,
  store,
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
  }: ChatJoinCleanCardSlice = useStore(
    store,
    useShallow(selectChatJoinCleanCardState)
  );
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
            onManualDragChange(Number(readEventTargetValue(event)));
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
        <InlineNoticeCollapse
          activeValue={
            !chatDetail.batchKickRunning ? chatDetail.lastBatchKickCompletion : null
          }
          resetKey={String(chatDetail.chatId)}
        >
          {(
            completion: Readonly<MiniAppBatchKickCompletion>
          ): React.JSX.Element => (
            <div className="join-clean-result-box">
              {t.chats.batchKickCompletedSummary(completion)}
            </div>
          )}
        </InlineNoticeCollapse>
      </div>
    </div>
  );
}

/** 按 `chatDetail` 与仓库引用浅比较跳过无关重渲染的批量清理卡片组件。 */
export const ChatJoinCleanCard: React.MemoExoticComponent<
  typeof ChatJoinCleanCardView
> = memo(ChatJoinCleanCardView);
