import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  CHAT_QA_MAX_PER_CHAT,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_CHAT_TARGET_KINDS,
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_TARGETS_MODAL_CLOSE_MS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import { CloseSvgIcon, PlusSvgIcon, RefreshSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppChatsStore, MiniAppChatsStoreState } from "../store/chats";
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
  /** `ChatsPage` 持有的受管群状态仓库实例。 */
  readonly store: MiniAppChatsStore;
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
        targets?.qaMax ?? CHAT_QA_MAX_PER_CHAT,
      ];
    case "deleteMessage":
      return [
        targets !== null
          ? targets.deleteMessageTargets.length
          : detail.deleteMessageTargetCount,
        targets?.deleteMessageMax ?? DELETE_MESSAGE_CHAT_TARGET_MAX,
      ];
    case "translate":
      return [
        targets !== null
          ? targets.translateTargets.length
          : detail.translateTargetCount,
        targets?.translateMax ?? TRANSLATE_CHAT_USER_LIMIT,
      ];
  }
}

/**
 * 生成目标弹窗子面板在激活态或退场过渡期的视图状态：激活态直接返回实时 `state`；
 * 退场期间返回关闭前捕获的表单与列表快照，并将 `translateLangMenuOpen` 置为 `false`。
 *
 * @param state 当前实时 store 状态
 * @param snapshotState 关闭前最后一次有效展开态捕获的 store 快照
 * @param isClosing 当前弹窗是否处于退场过渡期
 * @returns 供弹窗顶部折叠区与子面板渲染使用的状态对象
 */
export function resolveChatTargetsModalPanelState(
  state: MiniAppChatsStoreState,
  snapshotState: MiniAppChatsStoreState,
  isClosing: boolean
): MiniAppChatsStoreState {
  if (!isClosing) {
    return state;
  }
  return {
    ...snapshotState,
    translateLangMenuOpen: false,
  };
}

/** `syncChatTargetsModalCloseReset` 关闭卸载后重置高度记录引用的参数接口。 */
export interface SyncChatTargetsModalCloseResetOptions {
  /** 弹窗当前是否处于激活或退场挂载阶段。 */
  readonly isModalOpen: boolean;
  /** 上一次渲染的目标类别引用。 */
  readonly prevTabRef: React.RefObject<MiniAppChatTargetKind | null>;
  /** 上一次是否已加载目标数据的标记引用。 */
  readonly prevHadTargetsRef: React.RefObject<boolean>;
  /** 上一次记录的内容像素高度引用。 */
  readonly lastHeightRef: React.RefObject<number>;
}

/**
 * 在目标弹窗退场动画完成卸载后清空 `TabHeightSizer` 的上次标签、注水标志与高度记录引用。
 *
 * @param options 弹窗挂载标志与高度记录引用
 */
export function syncChatTargetsModalCloseReset({
  isModalOpen,
  prevTabRef,
  prevHadTargetsRef,
  lastHeightRef,
}: SyncChatTargetsModalCloseResetOptions): void {
  if (!isModalOpen) {
    prevTabRef.current = null;
    prevHadTargetsRef.current = false;
    lastHeightRef.current = 0;
  }
}

/** `ChatTargetsModalDialog` 纯展示对话框视图的属性参数。 */
export interface ChatTargetsModalDialogProps {
  /** 当前实时 store 状态。 */
  readonly state: MiniAppChatsStoreState;
  /** 关闭前捕获的 store 快照状态。 */
  readonly snapshotState: MiniAppChatsStoreState;
  /** 当前展示的目标类别。 */
  readonly displayModalKind: MiniAppChatTargetKind;
  /** 当前展示的群详情快照。 */
  readonly displayChatDetail: Readonly<MiniAppChatDetail>;
  /** 当前展示的群目标管理清单快照。 */
  readonly displayChatTargets: Readonly<MiniAppChatTargetsView> | null;
  /** 当前展示的目标清单加载标记。 */
  readonly displayLoadingTargets: boolean;
  /** 弹窗是否正处于退场收起阶段。 */
  readonly isClosing: boolean;
  /** 语言下拉外部遮罩是否挂载。 */
  readonly displayLangBackdropOpen: true | null;
  /** 语言下拉外部遮罩是否处于退场阶段。 */
  readonly langBackdropClosing: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 弹窗滚动体节点引用。 */
  readonly modalBodyRef: React.RefObject<ScrollableModalBodyElement | null>;
  /** 高度过渡外层节点引用。 */
  readonly sizerRef: React.RefObject<MeasurableBodyElement | null>;
  /** 高度过渡内层面板节点引用。 */
  readonly paneRef: React.RefObject<MeasurableBodyElement | null>;
  /** 上一次记录的内容像素高度引用。 */
  readonly lastHeightRef: React.RefObject<number>;
  /** 上一次渲染的目标类别引用。 */
  readonly prevTabRef: React.RefObject<MiniAppChatTargetKind | null>;
  /** 上一次是否已加载目标数据的标记引用。 */
  readonly prevHadTargetsRef: React.RefObject<boolean>;
  /** 平滑滚动弹窗内容至顶部的回调。 */
  readonly onScrollToTop: () => void;
  /** 可选受管群状态仓库；传入时由四个叶子面板各自按切片粒度订阅，未传时直接消费 `state`/`snapshotState`。 */
  readonly store?: MiniAppChatsStore;
}

/** `ChatTargetsModal` 弹窗外框订阅的状态与动作切片（不含各类表单草稿输入框）。 */
type ChatTargetsModalShellSlice = Pick<
  MiniAppChatsStoreState,
  | "activeTargetsModal"
  | "chatDetail"
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "translateLangMenuOpen"
  | "qaEditorOpen"
  | "targetAddMenuOpen"
  | "openQaEditor"
  | "openTargetAddMenu"
  | "closeTranslateLangMenu"
  | "switchTargetsModalTab"
  | "closeTargetsModal"
  | "loadChatTargets"
>;

/** 问答对编辑表单订阅的状态与动作切片。 */
type ChatTargetsQaEditorFormSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "mutatingTargets"
  | "qaEditorOpen"
  | "qaQuestionInput"
  | "qaAnswerInput"
  | "qaEditSourceQuestion"
  | "closeQaEditor"
  | "setQaQuestionInput"
  | "setQaAnswerInput"
  | "submitQaPair"
>;

/** 成员目标添加表单订阅的状态与动作切片。 */
type ChatTargetsMemberAddFormSlice = Pick<
  MiniAppChatsStoreState,
  | "mutatingTargets"
  | "targetAddMenuOpen"
  | "targetIdFormOpen"
  | "deleteTargetInput"
  | "translateTargetInput"
  | "translateLanguageInput"
  | "translateLangMenuOpen"
  | "closeTargetAddMenu"
  | "selectTargetAddMode"
  | "setDeleteTargetInput"
  | "setTranslateTargetInput"
  | "setTranslateLanguageInput"
  | "toggleTranslateLangMenu"
  | "submitDeleteTarget"
  | "submitTranslateTarget"
>;

/** 问答对列表面板订阅的状态与动作切片。 */
type ChatTargetsQaPanelSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "fillQaPairForEdit"
  | "removeQaPair"
>;

/** 成员目标列表面板订阅的状态与动作切片。 */
type ChatTargetsMemberPanelsSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "removeDeleteTarget"
  | "removeTranslateTarget"
>;

/**
 * 从受管群仓库提取弹窗外框渲染所需切片。
 *
 * @param state 受管群完整状态快照
 * @returns 弹窗外框切片
 */
function selectChatTargetsModalShellState(
  state: MiniAppChatsStoreState
): ChatTargetsModalShellSlice {
  return {
    activeTargetsModal: state.activeTargetsModal,
    chatDetail: state.chatDetail,
    chatTargets: state.chatTargets,
    loadingTargets: state.loadingTargets,
    mutatingTargets: state.mutatingTargets,
    translateLangMenuOpen: state.translateLangMenuOpen,
    qaEditorOpen: state.qaEditorOpen,
    targetAddMenuOpen: state.targetAddMenuOpen,
    openQaEditor: state.openQaEditor,
    openTargetAddMenu: state.openTargetAddMenu,
    closeTranslateLangMenu: state.closeTranslateLangMenu,
    switchTargetsModalTab: state.switchTargetsModalTab,
    closeTargetsModal: state.closeTargetsModal,
    loadChatTargets: state.loadChatTargets,
  };
}

/**
 * 从受管群仓库提取问答对折叠编辑表单切片。
 *
 * @param state 受管群完整状态快照
 * @returns 问答对编辑表单切片
 */
function selectQaEditorFormSlice(
  state: MiniAppChatsStoreState
): ChatTargetsQaEditorFormSlice {
  return {
    chatTargets: state.chatTargets,
    mutatingTargets: state.mutatingTargets,
    qaEditorOpen: state.qaEditorOpen,
    qaQuestionInput: state.qaQuestionInput,
    qaAnswerInput: state.qaAnswerInput,
    qaEditSourceQuestion: state.qaEditSourceQuestion,
    closeQaEditor: state.closeQaEditor,
    setQaQuestionInput: state.setQaQuestionInput,
    setQaAnswerInput: state.setQaAnswerInput,
    submitQaPair: state.submitQaPair,
  };
}

/**
 * 从受管群仓库提取成员目标折叠添加表单切片。
 *
 * @param state 受管群完整状态快照
 * @returns 成员目标添加表单切片
 */
function selectMemberAddFormSlice(
  state: MiniAppChatsStoreState
): ChatTargetsMemberAddFormSlice {
  return {
    mutatingTargets: state.mutatingTargets,
    targetAddMenuOpen: state.targetAddMenuOpen,
    targetIdFormOpen: state.targetIdFormOpen,
    deleteTargetInput: state.deleteTargetInput,
    translateTargetInput: state.translateTargetInput,
    translateLanguageInput: state.translateLanguageInput,
    translateLangMenuOpen: state.translateLangMenuOpen,
    closeTargetAddMenu: state.closeTargetAddMenu,
    selectTargetAddMode: state.selectTargetAddMode,
    setDeleteTargetInput: state.setDeleteTargetInput,
    setTranslateTargetInput: state.setTranslateTargetInput,
    setTranslateLanguageInput: state.setTranslateLanguageInput,
    toggleTranslateLangMenu: state.toggleTranslateLangMenu,
    submitDeleteTarget: state.submitDeleteTarget,
    submitTranslateTarget: state.submitTranslateTarget,
  };
}

/**
 * 从受管群仓库提取问答对列表面板切片。
 *
 * @param state 受管群完整状态快照
 * @returns 问答对列表切片
 */
function selectQaPanelSlice(
  state: MiniAppChatsStoreState
): ChatTargetsQaPanelSlice {
  return {
    chatTargets: state.chatTargets,
    loadingTargets: state.loadingTargets,
    mutatingTargets: state.mutatingTargets,
    fillQaPairForEdit: state.fillQaPairForEdit,
    removeQaPair: state.removeQaPair,
  };
}

/**
 * 从受管群仓库提取成员目标列表面板切片。
 *
 * @param state 受管群完整状态快照
 * @returns 成员目标列表切片
 */
function selectMemberPanelsSlice(
  state: MiniAppChatsStoreState
): ChatTargetsMemberPanelsSlice {
  return {
    chatTargets: state.chatTargets,
    loadingTargets: state.loadingTargets,
    mutatingTargets: state.mutatingTargets,
    removeDeleteTarget: state.removeDeleteTarget,
    removeTranslateTarget: state.removeTranslateTarget,
  };
}

/** 连接态子面板共用的仓库与退场快照属性。 */
interface ConnectedTargetsPanelBaseProps {
  /** 受管群状态仓库实例。 */
  readonly store: MiniAppChatsStore;
  /** 关闭前捕获的 store 快照状态。 */
  readonly snapshotState: MiniAppChatsStoreState;
  /** 弹窗是否正处于退场收起阶段。 */
  readonly isClosing: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 仅订阅问答对编辑表单切片的轻量连接包装器。
 *
 * @param props 仓库与退场快照属性
 * @returns React 节点
 */
function ConnectedChatTargetsQaEditorForm({
  store,
  snapshotState,
  isClosing,
  t,
}: ConnectedTargetsPanelBaseProps): React.JSX.Element {
  useStore(store, useShallow(selectQaEditorFormSlice));
  const panelState: MiniAppChatsStoreState = resolveChatTargetsModalPanelState(
    store.getState(),
    snapshotState,
    isClosing
  );
  return <ChatTargetsQaEditorForm state={panelState} t={t} />;
}

/**
 * 仅订阅成员目标添加表单切片的轻量连接包装器。
 *
 * @param props 目标类别、仓库与退场快照属性
 * @returns React 节点
 */
function ConnectedChatTargetsMemberAddForm({
  kind,
  store,
  snapshotState,
  isClosing,
  t,
}: ConnectedTargetsPanelBaseProps & {
  /** 成员目标类别。 */
  readonly kind: "deleteMessage" | "translate";
}): React.JSX.Element {
  useStore(store, useShallow(selectMemberAddFormSlice));
  const panelState: MiniAppChatsStoreState = resolveChatTargetsModalPanelState(
    store.getState(),
    snapshotState,
    isClosing
  );
  return <ChatTargetsMemberAddForm kind={kind} state={panelState} t={t} />;
}

/**
 * 仅订阅问答对列表切片的轻量连接包装器。
 *
 * @param props 仓库、退场快照与置顶滚动回调
 * @returns React 节点
 */
function ConnectedChatTargetsQaPanel({
  store,
  snapshotState,
  isClosing,
  t,
  onScrollToTop,
}: ConnectedTargetsPanelBaseProps & {
  /** 点击编辑后平滑滚动弹窗内容区至顶部的回调。 */
  readonly onScrollToTop: () => void;
}): React.JSX.Element {
  useStore(store, useShallow(selectQaPanelSlice));
  const panelState: MiniAppChatsStoreState = resolveChatTargetsModalPanelState(
    store.getState(),
    snapshotState,
    isClosing
  );
  return (
    <ChatTargetsQaPanel
      state={panelState}
      t={t}
      onScrollToTop={onScrollToTop}
    />
  );
}

/**
 * 仅订阅成员目标列表切片的轻量连接包装器。
 *
 * @param props 目标类别、群详情、仓库与退场快照属性
 * @returns React 节点
 */
function ConnectedChatTargetsMemberPanels({
  kind,
  chatDetail,
  store,
  snapshotState,
  isClosing,
  t,
}: ConnectedTargetsPanelBaseProps & {
  /** 成员目标类别。 */
  readonly kind: "deleteMessage" | "translate";
  /** 当前展示的群详情快照。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
}): React.JSX.Element {
  useStore(store, useShallow(selectMemberPanelsSlice));
  const panelState: MiniAppChatsStoreState = resolveChatTargetsModalPanelState(
    store.getState(),
    snapshotState,
    isClosing
  );
  return (
    <ChatTargetsMemberPanels
      kind={kind}
      chatDetail={chatDetail}
      state={panelState}
      t={t}
    />
  );
}

/**
 * 渲染受管群「目标与问答」弹窗的遮罩层、头部操作栏、标签栏、顶部折叠表单与目标列表面板。
 *
 * @param props 对话框展示状态与节点引用
 * @returns React 节点
 */
export function ChatTargetsModalDialog({
  state,
  snapshotState,
  displayModalKind,
  displayChatDetail,
  displayChatTargets,
  displayLoadingTargets,
  isClosing,
  displayLangBackdropOpen,
  langBackdropClosing,
  t,
  modalBodyRef,
  sizerRef,
  paneRef,
  lastHeightRef,
  prevTabRef,
  prevHadTargetsRef,
  onScrollToTop,
  store,
}: ChatTargetsModalDialogProps): React.JSX.Element {
  const {
    activeTargetsModal,
    mutatingTargets,
    translateLangMenuOpen,
    openQaEditor,
    openTargetAddMenu,
    closeTranslateLangMenu,
    switchTargetsModalTab,
    closeTargetsModal,
    loadChatTargets,
  }: MiniAppChatsStoreState = state;

  const panelState: MiniAppChatsStoreState = resolveChatTargetsModalPanelState(
    state,
    snapshotState,
    isClosing
  );

  const [activeCount, activeMax]: readonly [number, number] =
    resolveTargetKindCounts(
      displayModalKind,
      displayChatDetail,
      displayChatTargets
    );
  const isTopFormOpen: boolean =
    displayModalKind === "qa"
      ? panelState.qaEditorOpen
      : panelState.targetAddMenuOpen;
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
      aria-hidden={isClosing}
      aria-label={t.chats.targetsKindLabel[displayModalKind]}
      onClick={(): void => {
        if (!mutatingTargets && !isClosing) {
          closeTargetsModal();
        }
      }}
    >
      {displayLangBackdropOpen !== null ? (
        <div
          className={`chat-targets-lang-backdrop ${langBackdropClosing ? "closing" : ""}`}
          aria-hidden="true"
          onClick={(event: React.SyntheticEvent<HTMLDivElement>): void => {
            event.stopPropagation();
            if (!langBackdropClosing) {
              closeTranslateLangMenu();
            }
          }}
        />
      ) : null}
      <div
        className={`chat-targets-modal ${isClosing ? "closing" : ""}`}
        onClick={(event: React.SyntheticEvent<HTMLDivElement>): void => {
          event.stopPropagation();
          if (translateLangMenuOpen) {
            closeTranslateLangMenu();
          }
        }}
      >
        <div className="chat-targets-modal-header">
          <div className="chat-targets-modal-header-main">
            <div className="chat-targets-modal-title">
              {t.chats.targetsKindLabel[displayModalKind]}
            </div>
            <div className="chat-targets-modal-sub">
              {t.chats.targetsModalSubtitle(
                displayChatDetail.title,
                activeCount,
                activeMax
              )}
            </div>
          </div>
          <div className="chat-targets-modal-header-actions">
            <button
              type="button"
              className="btn icon-btn"
              disabled={displayLoadingTargets || mutatingTargets || isClosing}
              onClick={(): void => {
                void loadChatTargets(false);
              }}
            >
              <RefreshSvgIcon
                size={14}
                className={displayLoadingTargets ? "spin-icon" : ""}
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
                resolveTargetKindCounts(
                  kind,
                  displayChatDetail,
                  displayChatTargets
                );
              const isActive: boolean = displayModalKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isClosing ? -1 : undefined}
                  className={`chat-targets-tab ${isActive ? "active" : ""}`}
                  onClick={(): void => {
                    if (isClosing || kind === activeTargetsModal) {
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
            activeTab={displayModalKind}
            hasTargets={displayChatTargets !== null && !displayLoadingTargets}
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
                  tabIndex={isTopFormOpen || isClosing ? -1 : 0}
                  onClick={(): void => {
                    if (isClosing) {
                      return;
                    }
                    if (displayModalKind === "qa") {
                      openQaEditor();
                    } else {
                      openTargetAddMenu();
                    }
                  }}
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
                  store !== undefined ? (
                    <ConnectedChatTargetsQaEditorForm
                      store={store}
                      snapshotState={snapshotState}
                      isClosing={isClosing}
                      t={t}
                    />
                  ) : (
                    <ChatTargetsQaEditorForm state={panelState} t={t} />
                  )
                ) : store !== undefined ? (
                  <ConnectedChatTargetsMemberAddForm
                    kind={displayModalKind}
                    store={store}
                    snapshotState={snapshotState}
                    isClosing={isClosing}
                    t={t}
                  />
                ) : (
                  <ChatTargetsMemberAddForm
                    kind={displayModalKind}
                    state={panelState}
                    t={t}
                  />
                )}
              </CollapseGrid>
            </div>

            <div key={displayModalKind} className="chat-targets-tab-content">
              {displayModalKind === "qa" ? (
                store !== undefined ? (
                  <ConnectedChatTargetsQaPanel
                    store={store}
                    snapshotState={snapshotState}
                    isClosing={isClosing}
                    t={t}
                    onScrollToTop={onScrollToTop}
                  />
                ) : (
                  <ChatTargetsQaPanel
                    state={panelState}
                    t={t}
                    onScrollToTop={onScrollToTop}
                  />
                )
              ) : store !== undefined ? (
                <ConnectedChatTargetsMemberPanels
                  kind={displayModalKind}
                  chatDetail={displayChatDetail}
                  store={store}
                  snapshotState={snapshotState}
                  isClosing={isClosing}
                  t={t}
                />
              ) : (
                <ChatTargetsMemberPanels
                  kind={displayModalKind}
                  chatDetail={displayChatDetail}
                  state={panelState}
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

/**
 * 渲染受管群详情页的「目标与问答」管理弹窗（支持问答对、删发言目标、翻译目标的查看、新增与删除；
 * 关闭弹窗、离开详情或切群时保留面板与顶部表单快照完成退场动画，翻译语言下拉的外部点击遮罩与弹窗面板同级挂载于遮罩层内）。
 *
 * @param props 组件属性
 * @returns React 节点或 `null`
 */
export function ChatTargetsModal({
  store,
}: ChatTargetsModalProps): React.JSX.Element | null {
  const language: MiniAppLanguage = useMiniAppStore(
    (s: MiniAppUiStoreState): MiniAppLanguage => s.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const {
    activeTargetsModal,
    chatDetail,
    chatTargets,
    translateLangMenuOpen,
  }: ChatTargetsModalShellSlice = useStore(
    store,
    useShallow(selectChatTargetsModalShellState)
  );

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
  const lastActiveStateRef: React.RefObject<MiniAppChatsStoreState> =
    useRef<MiniAppChatsStoreState>(store.getState());

  const isModalActive: boolean =
    activeTargetsModal !== null && chatDetail !== null;
  if (isModalActive) {
    lastActiveStateRef.current = store.getState();
  }
  useEffect((): (() => void) => {
    const current: MiniAppChatsStoreState = store.getState();
    if (current.activeTargetsModal !== null && current.chatDetail !== null) {
      lastActiveStateRef.current = current;
    }
    return store.subscribe((next: MiniAppChatsStoreState): void => {
      if (next.activeTargetsModal !== null && next.chatDetail !== null) {
        lastActiveStateRef.current = next;
      }
    });
  }, [store]);

  const {
    displayValue: displayModalKind,
    isClosing,
  }: Readonly<DelayedUnmountState<MiniAppChatTargetKind>> = useDelayedUnmount(
    isModalActive ? activeTargetsModal : null,
    MINI_APP_TARGETS_MODAL_CLOSE_MS
  );
  const snapshotState: MiniAppChatsStoreState = isModalActive
    ? store.getState()
    : lastActiveStateRef.current;
  const displayChatDetail: MiniAppChatDetail | null = snapshotState.chatDetail;
  const displayChatTargets: MiniAppChatTargetsView | null =
    snapshotState.chatTargets;
  const displayLoadingTargets: boolean = snapshotState.loadingTargets;
  const isLangMenuActive: boolean =
    isModalActive &&
    activeTargetsModal === "translate" &&
    translateLangMenuOpen;
  const {
    displayValue: displayLangBackdropOpen,
    isClosing: langBackdropClosing,
  }: Readonly<DelayedUnmountState<true>> = useDelayedUnmount(
    isLangMenuActive ? true : null,
    MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS
  );

  const isModalOpen: boolean =
    displayModalKind !== null && displayChatDetail !== null;
  useModalBodyScrollLock(isModalOpen);
  useEffect((): void => {
    syncChatTargetsModalCloseReset({
      isModalOpen,
      prevTabRef,
      prevHadTargetsRef,
      lastHeightRef,
    });
  }, [isModalOpen]);

  const handleScrollToTop: () => void = useCallback((): void => {
    scrollModalBodyToTop(modalBodyRef.current);
  }, []);

  if (displayModalKind === null || displayChatDetail === null) {
    return null;
  }

  return (
    <ChatTargetsModalDialog
      store={store}
      state={store.getState()}
      snapshotState={snapshotState}
      displayModalKind={displayModalKind}
      displayChatDetail={displayChatDetail}
      displayChatTargets={displayChatTargets}
      displayLoadingTargets={displayLoadingTargets}
      isClosing={isClosing}
      displayLangBackdropOpen={displayLangBackdropOpen}
      langBackdropClosing={langBackdropClosing}
      t={t}
      modalBodyRef={modalBodyRef}
      sizerRef={sizerRef}
      paneRef={paneRef}
      lastHeightRef={lastHeightRef}
      prevTabRef={prevTabRef}
      prevHadTargetsRef={prevHadTargetsRef}
      onScrollToTop={handleScrollToTop}
    />
  );
}
