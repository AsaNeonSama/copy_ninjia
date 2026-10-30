import { useCallback, useRef } from "react";
import type React from "react";
import {
  MINI_APP_CHAT_TARGET_KINDS,
  MINI_APP_TARGETS_MODAL_CLOSE_MS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import { CloseSvgIcon, PlusSvgIcon, RefreshSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppChatsStoreState } from "../store/chats";
import type {
  MiniAppChatDetail,
  MiniAppChatTargetKind,
  MiniAppChatTargetsView,
  MiniAppLanguage,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { CollapseGrid, TriggerCollapseGrid } from "./animations/CollapseGrid";
import {
  readElementBodyHeight,
  scrollModalBodyToTop,
  TabHeightSizer,
  useModalBodyScrollLock,
} from "./animations/TabHeightSizer";
import type {
  MeasurableBodyElement,
  ScrollableModalBodyElement,
} from "./animations/TabHeightSizer";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import {
  ChatTargetsMemberAddForm,
  ChatTargetsMemberPanels,
} from "./ChatTargetsMemberPanels";
import {
  ChatTargetsQaEditorForm,
  ChatTargetsQaPanel,
} from "./ChatTargetsQaPanel";

/** `ChatTargetsModal` 组件入参。 */
export interface ChatTargetsModalProps {
  /** `ChatsPage` 持有的状态与动作快照。 */
  readonly state: MiniAppChatsStoreState;
}

/**
 * 计算指定目标类别在当前群中的已配置条数与容量上限。
 *
 * @param kind 目标类别键
 * @param detail 当前群详情
 * @param targets 当前群目标管理清单（尚未加载完成时为 `null`）
 * @returns `[当前条数, 容量上限]` 元组
 */
export function resolveTargetKindCounts(
  kind: MiniAppChatTargetKind,
  detail: Readonly<MiniAppChatDetail>,
  targets: Readonly<MiniAppChatTargetsView> | null
): readonly [number, number] {
  switch (kind) {
    case "qa":
      return [
        targets !== null ? targets.qaItems.length : detail.qaPairCount,
        targets?.qaMax ?? 15,
      ];
    case "deleteMessage":
      return [
        targets !== null
          ? targets.deleteMessageTargets.length
          : detail.deleteMessageTargetCount,
        targets?.deleteMessageMax ?? 15,
      ];
    case "translate":
      return [
        targets !== null
          ? targets.translateTargets.length
          : detail.translateTargetCount,
        targets?.translateMax ?? 5,
      ];
  }
}

/**
 * 渲染受管群详情页的「目标与问答」管理弹窗（支持问答对、删发言目标、翻译目标的查看、新增与删除）。
 *
 * @param props 组件属性
 * @returns React 节点或 `null`
 */
export function ChatTargetsModal({
  state,
}: ChatTargetsModalProps): React.JSX.Element | null {
  const language: MiniAppLanguage = useMiniAppStore(
    (s: MiniAppUiStoreState): MiniAppLanguage => s.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const {
    activeTargetsModal,
    chatDetail,
    chatTargets,
    loadingTargets,
    mutatingTargets,
    qaEditorOpen,
    targetAddMenuOpen,
    openQaEditor,
    openTargetAddMenu,
    switchTargetsModalTab,
    closeTargetsModal,
    loadChatTargets,
  }: MiniAppChatsStoreState = state;

  const modalBodyRef: React.RefObject<ScrollableModalBodyElement | null> =
    useRef<ScrollableModalBodyElement | null>(null);
  const sizerRef: React.RefObject<MeasurableBodyElement | null> =
    useRef<MeasurableBodyElement | null>(null);
  const paneRef: React.RefObject<MeasurableBodyElement | null> =
    useRef<MeasurableBodyElement | null>(null);
  const lastHeightRef: React.RefObject<number> = useRef<number>(0);
  const prevTabRef: React.RefObject<MiniAppChatTargetKind | null> =
    useRef<MiniAppChatTargetKind | null>(activeTargetsModal);
  const prevHadTargetsRef: React.RefObject<boolean> = useRef<boolean>(
    chatTargets !== null
  );

  const {
    displayValue: displayModalKind,
    isClosing,
  }: Readonly<DelayedUnmountState<MiniAppChatTargetKind>> = useDelayedUnmount(
    activeTargetsModal,
    MINI_APP_TARGETS_MODAL_CLOSE_MS
  );

  const isModalOpen: boolean =
    displayModalKind !== null && chatDetail !== null;
  useModalBodyScrollLock(isModalOpen);

  const handleScrollToTop: () => void = useCallback((): void => {
    scrollModalBodyToTop(modalBodyRef.current);
  }, []);

  if (displayModalKind === null || chatDetail === null) {
    return null;
  }

  const [activeCount, activeMax]: readonly [number, number] =
    resolveTargetKindCounts(displayModalKind, chatDetail, chatTargets);
  const isTopFormOpen: boolean =
    displayModalKind === "qa" ? qaEditorOpen : targetAddMenuOpen;
  const openTopFormButtonLabel: string =
    displayModalKind === "qa"
      ? t.chats.qaOpenEditorButton
      : displayModalKind === "deleteMessage"
        ? t.chats.deleteTargetAddButton
        : t.chats.translateTargetAddButton;

  return (
    <div
      className={`confirm-backdrop chat-targets-backdrop ${isClosing ? "closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t.chats.targetsKindLabel[displayModalKind]}
      onClick={(): void => {
        if (!mutatingTargets && !isClosing) {
          closeTargetsModal();
        }
      }}
    >
      <div
        className={`chat-targets-modal ${isClosing ? "closing" : ""}`}
        onClick={(event: React.SyntheticEvent<HTMLDivElement>): void => {
          event.stopPropagation();
        }}
      >
        <div className="chat-targets-modal-header">
          <div className="chat-targets-modal-header-main">
            <div className="chat-targets-modal-title">
              {t.chats.targetsKindLabel[displayModalKind]}
            </div>
            <div className="chat-targets-modal-sub">
              {t.chats.targetsModalSubtitle(
                chatDetail.title,
                activeCount,
                activeMax
              )}
            </div>
          </div>
          <div className="chat-targets-modal-header-actions">
            <button
              type="button"
              className="btn icon-btn"
              disabled={loadingTargets || mutatingTargets || isClosing}
              onClick={(): void => {
                void loadChatTargets();
              }}
            >
              <RefreshSvgIcon
                size={14}
                className={loadingTargets ? "spin-icon" : ""}
              />
              <span>{t.chats.targetsRefreshButton}</span>
            </button>
            <button
              type="button"
              className="btn icon-btn"
              disabled={mutatingTargets || isClosing}
              aria-label={t.chats.targetsCloseButton}
              onClick={closeTargetsModal}
            >
              <CloseSvgIcon size={14} />
              <span>{t.chats.targetsCloseButton}</span>
            </button>
          </div>
        </div>

        <div className="chat-targets-tabs" role="tablist">
          {MINI_APP_CHAT_TARGET_KINDS.map(
            (kind: MiniAppChatTargetKind): React.JSX.Element => {
              const [count, max]: readonly [number, number] =
                resolveTargetKindCounts(kind, chatDetail, chatTargets);
              const isActive: boolean = displayModalKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`chat-targets-tab ${isActive ? "active" : ""}`}
                  onClick={(): void => {
                    if (kind === activeTargetsModal) {
                      return;
                    }
                    const currentHeight: number =
                      readElementBodyHeight(paneRef.current) ||
                      readElementBodyHeight(sizerRef.current);
                    if (currentHeight > 0) {
                      lastHeightRef.current = currentHeight;
                      if (sizerRef.current?.style !== undefined) {
                        sizerRef.current.style.overflow = "hidden";
                        sizerRef.current.style.transition = "none";
                        sizerRef.current.style.height = `${currentHeight}px`;
                      }
                    }
                    scrollModalBodyToTop(modalBodyRef.current);
                    switchTargetsModalTab(kind);
                  }}
                >
                  <span className="chat-targets-tab-label">
                    {t.chats.targetsKindLabel[kind]}
                  </span>
                  <span className="chat-targets-tab-count">
                    {`${count}/${max}`}
                  </span>
                </button>
              );
            }
          )}
        </div>

        <div
          ref={(el: ScrollableModalBodyElement | null): void => {
            modalBodyRef.current = el;
          }}
          className="chat-targets-modal-body"
        >
          <TabHeightSizer
            activeTab={activeTargetsModal}
            hasTargets={chatTargets !== null && !loadingTargets}
            sizerRef={sizerRef}
            paneRef={paneRef}
            lastHeightRef={lastHeightRef}
            prevTabRef={prevTabRef}
            prevHadTargetsRef={prevHadTargetsRef}
          >
            <div className="chat-targets-qa-editor-shell">
              <TriggerCollapseGrid
                collapsed={isTopFormOpen}
                resetKey={displayModalKind}
                gridClassName="chat-targets-qa-trigger-collapse"
                innerClassName="chat-targets-qa-collapse-inner"
              >
                <button
                  type="button"
                  className="btn primary icon-btn chat-targets-qa-open-btn"
                  disabled={mutatingTargets}
                  tabIndex={isTopFormOpen ? -1 : 0}
                  onClick={
                    displayModalKind === "qa" ? openQaEditor : openTargetAddMenu
                  }
                >
                  <PlusSvgIcon size={14} />
                  <span>{openTopFormButtonLabel}</span>
                </button>
              </TriggerCollapseGrid>

              <CollapseGrid
                expanded={isTopFormOpen}
                resetKey={displayModalKind}
                gridClassName="chat-targets-qa-collapse-grid"
                innerClassName="chat-targets-qa-collapse-inner"
                fadeInner
              >
                {displayModalKind === "qa" ? (
                  <ChatTargetsQaEditorForm state={state} t={t} />
                ) : (
                  <ChatTargetsMemberAddForm
                    kind={displayModalKind}
                    state={state}
                    t={t}
                  />
                )}
              </CollapseGrid>
            </div>

            <div key={displayModalKind} className="chat-targets-tab-content">
              {displayModalKind === "qa" ? (
                <ChatTargetsQaPanel
                  state={state}
                  t={t}
                  onScrollToTop={handleScrollToTop}
                />
              ) : (
                <ChatTargetsMemberPanels
                  kind={displayModalKind}
                  chatDetail={chatDetail}
                  state={state}
                  t={t}
                />
              )}
            </div>
          </TabHeightSizer>
        </div>
      </div>
    </div>
  );
}
