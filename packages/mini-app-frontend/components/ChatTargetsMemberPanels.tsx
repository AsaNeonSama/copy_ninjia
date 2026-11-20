import { memo } from "react";
import type React from "react";
import { MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS } from "../consts/miniApp/animation";
import { MINI_APP_TRANSLATE_LANGUAGES } from "../consts/miniApp/chats";
import {
  readEventTargetValue,
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import {
  AlertSvgIcon,
  ChevronDownSvgIcon,
  CloseSvgIcon,
  PlusSvgIcon,
  TrashSvgIcon,
} from "../resource";
import type {
  ChatTargetsMemberAddFormSlice,
  ChatTargetsMemberPanelsSlice,
} from "../types/chatTargets";
import type {
  MiniAppChatDeleteTargetItem,
  MiniAppChatDetail,
  MiniAppTranslateLanguage,
} from "../types/miniApp/chats";
import type { MiniAppPickerSubjectKind } from "../types/miniApp/identities";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { AddModeButtonList } from "./AddModeButtonList";
import { CollapseGrid, InlineNoticeCollapse } from "./animations/CollapseGrid";
import {
  useClosingSnapshot,
  useDelayedUnmount,
} from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import { ChatTargetsListSkeleton } from "./skeletons/ChatTargetsListSkeleton";

/** 成员目标卡片列表单项的通用视图（兼容删发言目标与附带目标语言的追着翻目标）。 */
interface ChatMemberTargetListItem extends MiniAppChatDeleteTargetItem {
  /** 可选的目标翻译语言代码（仅追着翻目标携带）。 */
  readonly language?: MiniAppTranslateLanguage;
}

/** `ChatMemberTargetItemList` 成员目标卡片列表的属性参数。 */
interface ChatMemberTargetItemListProps {
  /** 已配置的删发言或追着翻目标列表。 */
  readonly items: readonly Readonly<ChatMemberTargetListItem>[];
  /** 当前是否正在提交目标变更。 */
  readonly mutatingTargets: boolean;
  /** 弹窗是否正处于退场收起阶段（禁用焦点与点击穿透）。 */
  readonly isClosing?: boolean;
  /** 单项移除按钮的展示文案。 */
  readonly removeButtonLabel: string;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 移除指定成员目标的回调。 */
  readonly onRemoveTarget: (id: number) => Promise<void>;
}

/**
 * 渲染删发言目标或追着翻目标卡片列表；与顶部折叠添加菜单及按 ID 输入状态隔离，按列表相关属性浅比较跳过重渲染。
 *
 * @param props 列表属性
 * @returns React 节点
 */
function ChatMemberTargetItemListView({
  items,
  mutatingTargets,
  isClosing = false,
  removeButtonLabel,
  t,
  onRemoveTarget,
}: ChatMemberTargetItemListProps): React.JSX.Element {
  return (
    <div className="chat-targets-list">
      {items.map(
        (item: Readonly<ChatMemberTargetListItem>): React.JSX.Element => (
          <div key={item.id} className="chat-targets-item">
            <div className="row-main">
              <div className="identity-title-row">
                <bdi
                  className="identity-name"
                  title={sanitizeBidiText(item.displayName)}
                >
                  {truncateDisplayText(item.displayName, 16)}
                </bdi>
                <span
                  className={`badge ${
                    item.isChannel
                      ? "identity-channel-badge"
                      : "identity-user-badge"
                  }`}
                >
                  {item.isChannel
                    ? t.identities.channelBadge
                    : t.identities.userBadge}
                </span>
                {item.language !== undefined ? (
                  <span className="badge ok">
                    {t.chats.translateLanguageLabels[item.language]}
                  </span>
                ) : null}
              </div>
              <div className="row-sub identity-sub-row">
                {`ID: ${item.id}${item.username !== undefined ? ` · @${sanitizeBidiText(item.username)}` : ""}`}
              </div>
            </div>
            <button
              type="button"
              className="btn danger icon-btn"
              disabled={mutatingTargets}
              tabIndex={isClosing ? -1 : undefined}
              onClick={(): void => {
                if (isClosing) {
                  return;
                }
                void onRemoveTarget(item.id);
              }}
            >
              <TrashSvgIcon size={13} />
              <span>{removeButtonLabel}</span>
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的成员目标列表组件。 */
const ChatMemberTargetItemList: React.MemoExoticComponent<
  typeof ChatMemberTargetItemListView
> = memo(ChatMemberTargetItemListView);

/** `ChatTargetsMemberAddForm` 删发言目标与翻译目标折叠添加表单的属性参数。 */
export interface ChatTargetsMemberAddFormProps {
  /** 当前展示的成员目标类别（`"deleteMessage"` 或 `"translate"`）。 */
  readonly kind: "deleteMessage" | "translate";
  /** 成员目标添加表单所需状态与动作切片。 */
  readonly state: ChatTargetsMemberAddFormSlice;
  /** 弹窗是否正处于退场收起阶段（禁用焦点与点击穿透）。 */
  readonly isClosing?: boolean;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染删发言目标或翻译目标折叠添加面板内部的三合一模式选择与按 ID 添加表单。
 *
 * @param props 目标类别、仓库切片、退场标志与翻译字典
 * @returns React 节点
 */
export function ChatTargetsMemberAddForm({
  kind,
  state,
  isClosing = false,
  t,
}: ChatTargetsMemberAddFormProps): React.JSX.Element {
  const {
    mutatingTargets,
    preparingPickerMode,
    targetAddMenuOpen,
    targetIdFormOpen,
    deleteTargetInput,
    translateTargetInput,
    translateLanguageInput,
    translateLangMenuOpen,
    closeTargetAddMenu,
    selectTargetAddMode,
    setDeleteTargetInput,
    setTranslateTargetInput,
    setTranslateLanguageInput,
    toggleTranslateLangMenu,
    submitDeleteTarget,
    submitTranslateTarget,
  }: ChatTargetsMemberAddFormSlice = state;

  const isDelete: boolean = kind === "deleteMessage";
  const inputPlaceholder: string = isDelete
    ? t.chats.deleteTargetInputPlaceholder
    : t.chats.translateTargetInputPlaceholder;
  const inputValue: string = isDelete
    ? deleteTargetInput
    : translateTargetInput;
  const displayIdFormOpen: boolean = useClosingSnapshot(
    targetIdFormOpen,
    targetAddMenuOpen
  );
  const displayMutating: boolean = useClosingSnapshot(
    mutatingTargets,
    targetAddMenuOpen
  );
  const displayPreparingPickerMode: MiniAppPickerSubjectKind | null =
    useClosingSnapshot(preparingPickerMode, targetAddMenuOpen);
  const displayInputValue: string = useClosingSnapshot(
    inputValue,
    targetAddMenuOpen && targetIdFormOpen
  );
  const onInputChange: (value: string) => void = isDelete
    ? setDeleteTargetInput
    : setTranslateTargetInput;
  const addingLabel: string = isDelete
    ? t.chats.deleteTargetAddingButton
    : t.chats.translateTargetAddingButton;
  const onSubmit: () => Promise<void> = isDelete
    ? submitDeleteTarget
    : submitTranslateTarget;
  const {
    displayValue: displayLangMenuOpen,
    isClosing: langMenuClosing,
  }: Readonly<DelayedUnmountState<true>> = useDelayedUnmount(
    !isDelete && !isClosing && translateLangMenuOpen ? true : null,
    MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS
  );

  return (
    <div className="chat-targets-form chat-targets-form-add-target">
      <div className="chat-targets-add-panel-head">
        {isDelete ? (
          <span className="chat-targets-field-label">
            {t.chats.deleteTargetAddButton}
          </span>
        ) : (
          <div
            className="chat-targets-lang-dropdown"
            onClick={(event: React.SyntheticEvent<HTMLDivElement>): void => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              className={`chat-targets-lang-trigger ${translateLangMenuOpen ? "active" : ""}`}
              disabled={mutatingTargets}
              tabIndex={targetAddMenuOpen && !isClosing ? 0 : -1}
              aria-haspopup="listbox"
              aria-expanded={translateLangMenuOpen}
              onClick={(): void => {
                if (!isClosing) {
                  toggleTranslateLangMenu();
                }
              }}
            >
              <span className="chat-targets-lang-trigger-label">
                {t.chats.translateLanguageLabels[translateLanguageInput]}
              </span>
              <ChevronDownSvgIcon
                size={13}
                className={`chevron-icon ${translateLangMenuOpen ? "rotated" : ""}`}
              />
            </button>
            {displayLangMenuOpen !== null ? (
              <div
                className={`chat-targets-lang-popover ${langMenuClosing ? "closing" : ""}`}
                role="listbox"
                aria-hidden={langMenuClosing}
              >
                {MINI_APP_TRANSLATE_LANGUAGES.map(
                  (
                    lang: MiniAppTranslateLanguage
                  ): React.JSX.Element => {
                    const isSelected: boolean =
                      translateLanguageInput === lang;
                    return (
                      <button
                        key={lang}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        disabled={langMenuClosing}
                        tabIndex={isClosing ? -1 : undefined}
                        className={`chat-targets-lang-option ${isSelected ? "active" : ""}`}
                        onClick={(): void => {
                          if (!isClosing) {
                            setTranslateLanguageInput(lang);
                          }
                        }}
                      >
                        <span className="chat-targets-lang-option-label">
                          {t.chats.translateLanguageLabels[lang]}
                        </span>
                        <span className="chat-targets-lang-option-code">
                          {lang.toUpperCase()}
                        </span>
                      </button>
                    );
                  }
                )}
              </div>
            ) : null}
          </div>
        )}
        <button
          type="button"
          className="btn icon-btn chat-targets-cancel-btn"
          disabled={displayMutating}
          tabIndex={targetAddMenuOpen && !isClosing ? 0 : -1}
          onClick={(): void => {
            if (!isClosing) {
              closeTargetAddMenu();
            }
          }}
        >
          <CloseSvgIcon size={14} />
          <span>{t.chats.qaCancelEditButton}</span>
        </button>
      </div>

      <AddModeButtonList
        idFormOpen={displayIdFormOpen}
        disabled={displayMutating}
        loadingMode={displayPreparingPickerMode}
        interactive={targetAddMenuOpen && !isClosing}
        className="chat-targets-add-mode-grid"
        t={t}
        onSelectMode={selectTargetAddMode}
      />

      <CollapseGrid
        expanded={displayIdFormOpen}
        gridClassName="chat-targets-qa-collapse-grid"
        innerClassName="chat-targets-qa-collapse-inner"
        fadeInner
      >
        <div className="chat-targets-id-inline-row">
          <input
            type="text"
            className="chat-targets-input"
            placeholder={inputPlaceholder}
            value={displayInputValue}
            disabled={displayMutating}
            tabIndex={
              targetAddMenuOpen && targetIdFormOpen && !isClosing ? 0 : -1
            }
            onChange={(
              event: React.ChangeEvent<HTMLInputElement>
            ): void => {
              if (isClosing) {
                return;
              }
              onInputChange(readEventTargetValue(event));
            }}
          />
          <button
            type="button"
            className="btn primary icon-btn chat-targets-inline-btn"
            disabled={
              displayMutating ||
              displayInputValue.trim().length === 0
            }
            tabIndex={
              targetAddMenuOpen && targetIdFormOpen && !isClosing ? 0 : -1
            }
            onClick={(): void => {
              if (isClosing) {
                return;
              }
              void onSubmit();
            }}
          >
            <PlusSvgIcon size={14} />
            <span>
              {displayMutating ? addingLabel : t.identities.idConfirmButton}
            </span>
          </button>
        </div>
      </CollapseGrid>
    </div>
  );
}

/** `ChatTargetsMemberPanels` 删发言目标与翻译目标管理面板的属性参数。 */
export interface ChatTargetsMemberPanelsProps {
  /** 当前展示的成员目标类别（`"deleteMessage"` 或 `"translate"`）。 */
  readonly kind: "deleteMessage" | "translate";
  /** 当前群详情快照。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
  /** 成员目标列表面板所需状态与动作切片。 */
  readonly state: ChatTargetsMemberPanelsSlice;
  /** 弹窗是否正处于退场收起阶段（禁用焦点与点击穿透）。 */
  readonly isClosing?: boolean;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染群目标管理弹窗中的「删发言目标」或「翻译目标」列表面板（含权限/功能前置告警与成员列表）。
 *
 * @param props 目标类别、群详情、仓库切片、退场标志与翻译字典
 * @returns React 节点
 */
export function ChatTargetsMemberPanels({
  kind,
  chatDetail,
  state,
  isClosing = false,
  t,
}: ChatTargetsMemberPanelsProps): React.JSX.Element {
  const {
    chatTargets,
    loadingTargets,
    mutatingTargets,
    removeDeleteTarget,
    removeTranslateTarget,
  }: ChatTargetsMemberPanelsSlice = state;

  const isDelete: boolean = kind === "deleteMessage";
  const missingDeletePermission: boolean =
    chatDetail.botPermissions !== null &&
    !chatDetail.botPermissions.canDeleteMessages;
  const translateFeatureDisabled: boolean = !(
    chatTargets?.isTranslationEnabled ?? chatDetail.features.translation
  );
  const prereqWarnText: string | null =
    isDelete && missingDeletePermission
      ? t.serverNotice("DELETE_TARGET_MISSING_BOT_PERMISSION")
      : !isDelete && translateFeatureDisabled
        ? t.serverNotice("TRANSLATE_FEATURE_DISABLED")
        : null;

  return (
    <div className="chat-targets-member-panel">
      <InlineNoticeCollapse activeValue={prereqWarnText} resetKey={kind}>
        {(warnText: string): React.JSX.Element => (
          <div className="chat-targets-prereq-warn">
            <AlertSvgIcon size={14} />
            <span>{warnText}</span>
          </div>
        )}
      </InlineNoticeCollapse>

      {loadingTargets ? (
        <ChatTargetsListSkeleton />
      ) : isDelete ? (
        (chatTargets?.deleteMessageTargets.length ?? 0) === 0 ? (
          <div className="empty">{t.chats.deleteTargetEmptyHint}</div>
        ) : (
          <ChatMemberTargetItemList
            items={chatTargets!.deleteMessageTargets}
            mutatingTargets={mutatingTargets}
            isClosing={isClosing}
            removeButtonLabel={t.chats.deleteTargetRemoveButton}
            t={t}
            onRemoveTarget={removeDeleteTarget}
          />
        )
      ) : (chatTargets?.translateTargets.length ?? 0) === 0 ? (
        <div className="empty">{t.chats.translateTargetEmptyHint}</div>
      ) : (
        <ChatMemberTargetItemList
          items={chatTargets!.translateTargets}
          mutatingTargets={mutatingTargets}
          isClosing={isClosing}
          removeButtonLabel={t.chats.translateTargetRemoveButton}
          t={t}
          onRemoveTarget={removeTranslateTarget}
        />
      )}
    </div>
  );
}
