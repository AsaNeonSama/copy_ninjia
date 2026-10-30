import { Fragment, memo } from "react";
import type React from "react";
import {
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_TRANSLATE_LANGUAGES,
} from "../consts/miniApp";
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
import type { MiniAppChatsStoreState } from "../store/chats";
import type {
  MiniAppChatDeleteTargetItem,
  MiniAppChatDetail,
  MiniAppChatTranslateTargetItem,
  MiniAppTranslateLanguage,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { AddModeButtonList } from "./AddModeButtonList";
import { CollapseGrid } from "./animations/CollapseGrid";
import {
  useClosingSnapshot,
  useDelayedUnmount,
} from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import { ChatTargetsListSkeleton } from "./skeletons/ChatTargetsListSkeleton";

/** `DeleteTargetItemList` 删发言目标卡片列表的属性参数。 */
interface DeleteTargetItemListProps {
  /** 已配置的删发言目标列表。 */
  readonly items: readonly Readonly<MiniAppChatDeleteTargetItem>[];
  /** 当前是否正在提交目标变更。 */
  readonly mutatingTargets: boolean;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 移除指定删发言目标的回调。 */
  readonly onRemoveDeleteTarget: (id: number) => Promise<void>;
}

/**
 * 渲染删发言目标卡片列表；与顶部折叠添加菜单及按 ID 输入状态隔离，使展开/收起添加菜单或输入文字时不重排列表项。
 *
 * @param props 列表属性
 * @returns React 节点
 */
function DeleteTargetItemListView({
  items,
  mutatingTargets,
  t,
  onRemoveDeleteTarget,
}: DeleteTargetItemListProps): React.JSX.Element {
  return (
    <div className="chat-targets-list">
      {items.map(
        (item: Readonly<MiniAppChatDeleteTargetItem>): React.JSX.Element => (
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
              </div>
              <div className="row-sub identity-sub-row">
                {`ID: ${item.id}${item.username !== undefined ? ` · @${sanitizeBidiText(item.username)}` : ""}`}
              </div>
            </div>
            <button
              type="button"
              className="btn danger icon-btn"
              disabled={mutatingTargets}
              onClick={(): void => {
                void onRemoveDeleteTarget(item.id);
              }}
            >
              <TrashSvgIcon size={13} />
              <span>{t.chats.deleteTargetRemoveButton}</span>
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的删发言目标列表组件。 */
const DeleteTargetItemList: React.MemoExoticComponent<
  typeof DeleteTargetItemListView
> = memo(DeleteTargetItemListView);

/** `TranslateTargetItemList` 翻译目标卡片列表的属性参数。 */
interface TranslateTargetItemListProps {
  /** 已配置的翻译目标列表。 */
  readonly items: readonly Readonly<MiniAppChatTranslateTargetItem>[];
  /** 当前是否正在提交目标变更。 */
  readonly mutatingTargets: boolean;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 移除指定翻译目标的回调。 */
  readonly onRemoveTranslateTarget: (id: number) => Promise<void>;
}

/**
 * 渲染翻译目标卡片列表；与顶部折叠添加菜单及按 ID 输入状态隔离，使展开/收起添加菜单或输入文字时不重排列表项。
 *
 * @param props 列表属性
 * @returns React 节点
 */
function TranslateTargetItemListView({
  items,
  mutatingTargets,
  t,
  onRemoveTranslateTarget,
}: TranslateTargetItemListProps): React.JSX.Element {
  return (
    <div className="chat-targets-list">
      {items.map(
        (item: Readonly<MiniAppChatTranslateTargetItem>): React.JSX.Element => (
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
                <span className="badge ok">
                  {t.chats.translateLanguageLabels[item.language]}
                </span>
              </div>
              <div className="row-sub identity-sub-row">
                {`ID: ${item.id}${item.username !== undefined ? ` · @${sanitizeBidiText(item.username)}` : ""}`}
              </div>
            </div>
            <button
              type="button"
              className="btn danger icon-btn"
              disabled={mutatingTargets}
              onClick={(): void => {
                void onRemoveTranslateTarget(item.id);
              }}
            >
              <TrashSvgIcon size={13} />
              <span>{t.chats.translateTargetRemoveButton}</span>
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的翻译目标列表组件。 */
const TranslateTargetItemList: React.MemoExoticComponent<
  typeof TranslateTargetItemListView
> = memo(TranslateTargetItemListView);

/** `ChatTargetsMemberAddForm` 删发言目标与翻译目标折叠添加表单的属性参数。 */
export interface ChatTargetsMemberAddFormProps {
  /** 当前展示的成员目标类别（`"deleteMessage"` 或 `"translate"`）。 */
  readonly kind: "deleteMessage" | "translate";
  /** `ChatsPage` 持有的状态与动作快照。 */
  readonly state: MiniAppChatsStoreState;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染删发言目标或翻译目标折叠添加面板内部的三合一模式选择与按 ID 添加表单。
 *
 * @param props 目标类别、仓库状态与翻译字典
 * @returns React 节点
 */
export function ChatTargetsMemberAddForm({
  kind,
  state,
  t,
}: ChatTargetsMemberAddFormProps): React.JSX.Element {
  const {
    mutatingTargets,
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
    closeTranslateLangMenu,
    submitDeleteTarget,
    submitTranslateTarget,
  }: MiniAppChatsStoreState = state;

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
    translateLangMenuOpen ? true : null,
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
          <div className="chat-targets-lang-dropdown">
            <button
              type="button"
              className={`chat-targets-lang-trigger ${translateLangMenuOpen ? "active" : ""}`}
              disabled={mutatingTargets}
              tabIndex={targetAddMenuOpen ? 0 : -1}
              aria-haspopup="listbox"
              aria-expanded={translateLangMenuOpen}
              onClick={toggleTranslateLangMenu}
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
              <Fragment>
                <div
                  className={`chat-targets-lang-backdrop ${langMenuClosing ? "closing" : ""}`}
                  onClick={(): void => {
                    if (!langMenuClosing) {
                      closeTranslateLangMenu();
                    }
                  }}
                />
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
                          className={`chat-targets-lang-option ${isSelected ? "active" : ""}`}
                          onClick={(): void => {
                            setTranslateLanguageInput(lang);
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
              </Fragment>
            ) : null}
          </div>
        )}
        <button
          type="button"
          className="btn icon-btn chat-targets-cancel-btn"
          disabled={displayMutating}
          tabIndex={targetAddMenuOpen ? 0 : -1}
          onClick={closeTargetAddMenu}
        >
          <CloseSvgIcon size={14} />
          <span>{t.chats.qaCancelEditButton}</span>
        </button>
      </div>

      <AddModeButtonList
        idFormOpen={displayIdFormOpen}
        disabled={displayMutating}
        interactive={targetAddMenuOpen}
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
            tabIndex={targetAddMenuOpen && targetIdFormOpen ? 0 : -1}
            onChange={(
              event: React.ChangeEvent<HTMLInputElement>
            ): void => {
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
            tabIndex={targetAddMenuOpen && targetIdFormOpen ? 0 : -1}
            onClick={(): void => {
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
  /** `ChatsPage` 持有的状态与动作快照。 */
  readonly state: MiniAppChatsStoreState;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染群目标管理弹窗中的「删发言目标」或「翻译目标」列表面板（含权限/功能前置告警与成员列表）。
 *
 * @param props 目标类别、群详情、仓库状态与翻译字典
 * @returns React 节点
 */
export function ChatTargetsMemberPanels({
  kind,
  chatDetail,
  state,
  t,
}: ChatTargetsMemberPanelsProps): React.JSX.Element {
  const {
    chatTargets,
    loadingTargets,
    mutatingTargets,
    removeDeleteTarget,
    removeTranslateTarget,
  }: MiniAppChatsStoreState = state;

  const isDelete: boolean = kind === "deleteMessage";
  const missingDeletePermission: boolean =
    chatDetail.botPermissions !== null &&
    !chatDetail.botPermissions.canDeleteMessages;
  const translateFeatureDisabled: boolean = !(
    chatTargets?.isTranslationEnabled ?? chatDetail.features.translation
  );

  return (
    <Fragment>
      {isDelete && missingDeletePermission ? (
        <div className="chat-targets-prereq-warn">
          <AlertSvgIcon size={14} />
          <span>{t.serverNotice("DELETE_TARGET_MISSING_BOT_PERMISSION")}</span>
        </div>
      ) : null}
      {!isDelete && translateFeatureDisabled ? (
        <div className="chat-targets-prereq-warn">
          <AlertSvgIcon size={14} />
          <span>{t.serverNotice("TRANSLATE_FEATURE_DISABLED")}</span>
        </div>
      ) : null}

      {loadingTargets ? (
        <ChatTargetsListSkeleton />
      ) : isDelete ? (
        (chatTargets?.deleteMessageTargets.length ?? 0) === 0 ? (
          <div className="empty">{t.chats.deleteTargetEmptyHint}</div>
        ) : (
          <DeleteTargetItemList
            items={chatTargets!.deleteMessageTargets}
            mutatingTargets={mutatingTargets}
            t={t}
            onRemoveDeleteTarget={removeDeleteTarget}
          />
        )
      ) : (chatTargets?.translateTargets.length ?? 0) === 0 ? (
        <div className="empty">{t.chats.translateTargetEmptyHint}</div>
      ) : (
        <TranslateTargetItemList
          items={chatTargets!.translateTargets}
          mutatingTargets={mutatingTargets}
          t={t}
          onRemoveTranslateTarget={removeTranslateTarget}
        />
      )}
    </Fragment>
  );
}
