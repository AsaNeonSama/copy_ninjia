import { Fragment } from "react";
import type React from "react";
import { MINI_APP_TRANSLATE_LANGUAGES } from "../consts/miniApp";
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
import { CollapseGrid, TriggerCollapseGrid } from "./animations/CollapseGrid";
import { ChatTargetsListSkeleton } from "./skeletons/ChatTargetsListSkeleton";

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
 * 渲染群目标管理弹窗中的「删发言目标」或「翻译目标」面板（含权限/功能前置告警、三选一添加菜单与成员列表）。
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
    targetAddMenuOpen,
    targetIdFormOpen,
    deleteTargetInput,
    translateTargetInput,
    translateLanguageInput,
    translateLangMenuOpen,
    openTargetAddMenu,
    closeTargetAddMenu,
    selectTargetAddMode,
    setDeleteTargetInput,
    setTranslateTargetInput,
    setTranslateLanguageInput,
    toggleTranslateLangMenu,
    closeTranslateLangMenu,
    submitDeleteTarget,
    removeDeleteTarget,
    submitTranslateTarget,
    removeTranslateTarget,
  }: MiniAppChatsStoreState = state;

  const isDelete: boolean = kind === "deleteMessage";
  const missingDeletePermission: boolean =
    chatDetail.botPermissions !== null &&
    !chatDetail.botPermissions.canDeleteMessages;
  const translateFeatureDisabled: boolean = !(
    chatTargets?.isTranslationEnabled ?? chatDetail.features.translation
  );

  const inputPlaceholder: string = isDelete
    ? t.chats.deleteTargetInputPlaceholder
    : t.chats.translateTargetInputPlaceholder;
  const inputValue: string = isDelete
    ? deleteTargetInput
    : translateTargetInput;
  const onInputChange: (value: string) => void = isDelete
    ? setDeleteTargetInput
    : setTranslateTargetInput;
  const addingLabel: string = isDelete
    ? t.chats.deleteTargetAddingButton
    : t.chats.translateTargetAddingButton;
  const onSubmit: () => Promise<void> = isDelete
    ? submitDeleteTarget
    : submitTranslateTarget;

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

      <div className="chat-targets-qa-editor-shell">
        <TriggerCollapseGrid
          collapsed={targetAddMenuOpen}
          gridClassName="chat-targets-qa-trigger-collapse"
          innerClassName="chat-targets-qa-collapse-inner"
        >
          <button
            type="button"
            className="btn primary icon-btn chat-targets-qa-open-btn"
            disabled={mutatingTargets}
            tabIndex={targetAddMenuOpen ? -1 : 0}
            onClick={openTargetAddMenu}
          >
            <PlusSvgIcon size={14} />
            <span>
              {isDelete
                ? t.chats.deleteTargetAddButton
                : t.chats.translateTargetAddButton}
            </span>
          </button>
        </TriggerCollapseGrid>

        <CollapseGrid
          expanded={targetAddMenuOpen}
          gridClassName="chat-targets-qa-collapse-grid"
          innerClassName="chat-targets-qa-collapse-inner"
        >
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
                    disabled={mutatingTargets || !targetAddMenuOpen}
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
                  {translateLangMenuOpen ? (
                    <Fragment>
                      <div
                        className="chat-targets-lang-backdrop"
                        onClick={closeTranslateLangMenu}
                      />
                      <div
                        className="chat-targets-lang-popover"
                        role="listbox"
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
                disabled={mutatingTargets || !targetAddMenuOpen}
                tabIndex={targetAddMenuOpen ? 0 : -1}
                onClick={closeTargetAddMenu}
              >
                <CloseSvgIcon size={14} />
                <span>{t.chats.qaCancelEditButton}</span>
              </button>
            </div>

            <AddModeButtonList
              idFormOpen={targetIdFormOpen}
              disabled={mutatingTargets}
              interactive={targetAddMenuOpen}
              className="chat-targets-add-mode-grid"
              t={t}
              onSelectMode={selectTargetAddMode}
            />

            <CollapseGrid
              expanded={targetIdFormOpen}
              gridClassName="chat-targets-qa-collapse-grid"
              innerClassName="chat-targets-qa-collapse-inner"
            >
              <div className="chat-targets-id-inline-row">
                <input
                  type="text"
                  className="chat-targets-input"
                  placeholder={inputPlaceholder}
                  value={inputValue}
                  disabled={
                    mutatingTargets || !targetAddMenuOpen || !targetIdFormOpen
                  }
                  tabIndex={targetAddMenuOpen && targetIdFormOpen ? 0 : -1}
                  onChange={(
                    event: React.ChangeEvent<HTMLInputElement>
                  ): void => {
                    const rawValue: string = (
                      event.currentTarget as unknown as {
                        readonly value: string;
                      }
                    ).value;
                    onInputChange(rawValue);
                  }}
                />
                <button
                  type="button"
                  className="btn primary icon-btn chat-targets-inline-btn"
                  disabled={
                    mutatingTargets ||
                    !targetAddMenuOpen ||
                    !targetIdFormOpen ||
                    inputValue.trim().length === 0
                  }
                  tabIndex={targetAddMenuOpen && targetIdFormOpen ? 0 : -1}
                  onClick={(): void => {
                    void onSubmit();
                  }}
                >
                  <PlusSvgIcon size={14} />
                  <span>
                    {mutatingTargets ? addingLabel : t.identities.idConfirmButton}
                  </span>
                </button>
              </div>
            </CollapseGrid>
          </div>
        </CollapseGrid>
      </div>

      {loadingTargets ? (
        <ChatTargetsListSkeleton />
      ) : isDelete ? (
        (chatTargets?.deleteMessageTargets.length ?? 0) === 0 ? (
          <div className="empty">{t.chats.deleteTargetEmptyHint}</div>
        ) : (
          <div className="chat-targets-list">
            {chatTargets!.deleteMessageTargets.map(
              (
                item: Readonly<MiniAppChatDeleteTargetItem>
              ): React.JSX.Element => (
                <div key={item.id} className="chat-targets-item">
                  <div className="row-main">
                    <div className="row-title">
                      {item.displayName}{" "}
                      <span
                        className={`badge ${item.isChannel ? "warn" : "ok"}`}
                      >
                        {item.isChannel
                          ? t.identities.channelBadge
                          : t.identities.userBadge}
                      </span>
                    </div>
                    <div className="row-sub">
                      {`ID: ${item.id}${item.username !== undefined ? ` · @${item.username}` : ""}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn danger icon-btn"
                    disabled={mutatingTargets}
                    onClick={(): void => {
                      void removeDeleteTarget(item.id);
                    }}
                  >
                    <TrashSvgIcon size={13} />
                    <span>{t.chats.deleteTargetRemoveButton}</span>
                  </button>
                </div>
              )
            )}
          </div>
        )
      ) : (chatTargets?.translateTargets.length ?? 0) === 0 ? (
        <div className="empty">{t.chats.translateTargetEmptyHint}</div>
      ) : (
        <div className="chat-targets-list">
          {chatTargets!.translateTargets.map(
            (
              item: Readonly<MiniAppChatTranslateTargetItem>
            ): React.JSX.Element => (
              <div key={item.id} className="chat-targets-item">
                <div className="row-main">
                  <div className="row-title">
                    {item.displayName}{" "}
                    <span className="badge ok">
                      {t.chats.translateLanguageLabels[item.language]}
                    </span>
                  </div>
                  <div className="row-sub">
                    {`ID: ${item.id}${item.username !== undefined ? ` · @${item.username}` : ""}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn danger icon-btn"
                  disabled={mutatingTargets}
                  onClick={(): void => {
                    void removeTranslateTarget(item.id);
                  }}
                >
                  <TrashSvgIcon size={13} />
                  <span>{t.chats.translateTargetRemoveButton}</span>
                </button>
              </div>
            )
          )}
        </div>
      )}
    </Fragment>
  );
}
