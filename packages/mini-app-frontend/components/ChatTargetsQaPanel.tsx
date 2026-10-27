import type React from "react";
import { truncateDisplayText } from "../libs/formatters";
import { CloseSvgIcon, PlusSvgIcon, TrashSvgIcon } from "../resource";
import type { MiniAppChatsStoreState } from "../store/chats";
import type { MiniAppChatQaItem } from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { CollapseGrid, TriggerCollapseGrid } from "./animations/CollapseGrid";
import { ChatTargetsListSkeleton } from "./skeletons/ChatTargetsListSkeleton";

/** `ChatTargetsQaPanel` 问答对管理面板的属性参数。 */
export interface ChatTargetsQaPanelProps {
  /** `ChatsPage` 持有的状态与动作快照。 */
  readonly state: MiniAppChatsStoreState;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 点击「填入编辑」时将弹窗内容区平滑滚动至顶部的回调。 */
  readonly onScrollToTop?: () => void;
}

/**
 * 渲染群目标管理弹窗中的「问答对」面板（支持折叠式新增/编辑表单与问答列表管理）。
 *
 * @param props 仓库状态与翻译字典
 * @returns React 节点
 */
export function ChatTargetsQaPanel({
  state,
  t,
  onScrollToTop,
}: ChatTargetsQaPanelProps): React.JSX.Element {
  const {
    chatTargets,
    loadingTargets,
    mutatingTargets,
    qaEditorOpen,
    qaQuestionInput,
    qaAnswerInput,
    openQaEditor,
    closeQaEditor,
    setQaQuestionInput,
    setQaAnswerInput,
    fillQaPairForEdit,
    submitQaPair,
    removeQaPair,
  }: MiniAppChatsStoreState = state;

  const qaQuestionMaxChars: number = chatTargets?.qaQuestionMaxChars ?? 256;
  const qaAnswerMaxChars: number = chatTargets?.qaAnswerMaxChars ?? 3_840;

  return (
    <>
      <div className="chat-targets-qa-editor-shell">
        <TriggerCollapseGrid
          collapsed={qaEditorOpen}
          gridClassName="chat-targets-qa-trigger-collapse"
          innerClassName="chat-targets-qa-collapse-inner"
        >
          <button
            type="button"
            className="btn primary icon-btn chat-targets-qa-open-btn"
            disabled={mutatingTargets || qaEditorOpen}
            tabIndex={qaEditorOpen ? -1 : 0}
            onClick={openQaEditor}
          >
            <PlusSvgIcon size={14} />
            <span>{t.chats.qaOpenEditorButton}</span>
          </button>
        </TriggerCollapseGrid>

        <CollapseGrid
          expanded={qaEditorOpen}
          gridClassName="chat-targets-qa-collapse-grid"
          innerClassName="chat-targets-qa-collapse-inner"
        >
          <div className="chat-targets-form chat-targets-form-qa">
            <div className="chat-targets-field">
              <div className="chat-targets-field-head">
                <span className="chat-targets-field-label">
                  {t.chats.qaQuestionLabel}
                </span>
                <span className="chat-targets-field-counter">
                  {`${qaQuestionInput.length}/${qaQuestionMaxChars}`}
                </span>
              </div>
              <input
                type="text"
                className="chat-targets-input"
                maxLength={qaQuestionMaxChars}
                placeholder={t.chats.qaQuestionPlaceholder(qaQuestionMaxChars)}
                value={qaQuestionInput}
                disabled={mutatingTargets || !qaEditorOpen}
                tabIndex={qaEditorOpen ? 0 : -1}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  const rawValue: string = (
                    event.currentTarget as unknown as { readonly value: string }
                  ).value;
                  setQaQuestionInput(rawValue);
                }}
              />
            </div>
            <div className="chat-targets-field">
              <div className="chat-targets-field-head">
                <span className="chat-targets-field-label">
                  {t.chats.qaAnswerLabel}
                </span>
                <span className="chat-targets-field-counter">
                  {`${qaAnswerInput.length}/${qaAnswerMaxChars}`}
                </span>
              </div>
              <textarea
                className="chat-targets-textarea"
                rows={3}
                maxLength={qaAnswerMaxChars}
                placeholder={t.chats.qaAnswerPlaceholder(qaAnswerMaxChars)}
                value={qaAnswerInput}
                disabled={mutatingTargets || !qaEditorOpen}
                tabIndex={qaEditorOpen ? 0 : -1}
                onChange={(
                  event: React.ChangeEvent<HTMLTextAreaElement>
                ): void => {
                  const rawValue: string = (
                    event.currentTarget as unknown as { readonly value: string }
                  ).value;
                  setQaAnswerInput(rawValue);
                }}
              />
            </div>
            <div className="chat-targets-qa-form-actions">
              <button
                type="button"
                className="btn primary icon-btn chat-targets-submit-btn"
                disabled={
                  mutatingTargets ||
                  !qaEditorOpen ||
                  qaQuestionInput.trim().length === 0 ||
                  qaAnswerInput.trim().length === 0
                }
                tabIndex={qaEditorOpen ? 0 : -1}
                onClick={(): void => {
                  void submitQaPair();
                }}
              >
                <PlusSvgIcon size={14} />
                <span>
                  {mutatingTargets ? t.chats.qaSavingButton : t.chats.qaSaveButton}
                </span>
              </button>
              <button
                type="button"
                className="btn icon-btn chat-targets-cancel-btn"
                disabled={mutatingTargets || !qaEditorOpen}
                tabIndex={qaEditorOpen ? 0 : -1}
                onClick={closeQaEditor}
              >
                <CloseSvgIcon size={14} />
                <span>{t.chats.qaCancelEditButton}</span>
              </button>
            </div>
          </div>
        </CollapseGrid>
      </div>

      {loadingTargets ? (
        <ChatTargetsListSkeleton />
      ) : (chatTargets?.qaItems.length ?? 0) === 0 ? (
        <div className="empty">{t.chats.qaEmptyHint}</div>
      ) : (
        <div className="chat-targets-list">
          {chatTargets!.qaItems.map(
            (item: Readonly<MiniAppChatQaItem>): React.JSX.Element => (
              <div
                key={item.q}
                className="chat-targets-item chat-targets-qa-item"
              >
                <div className="chat-targets-qa-main">
                  <div className="chat-targets-qa-q">
                    <span className="badge ok">Q</span>
                    <span className="chat-targets-qa-q-text" title={item.q}>
                      {truncateDisplayText(item.q.replace(/\s+/gu, " "), 18)}
                    </span>
                  </div>
                  <div className="chat-targets-qa-a" title={item.a}>
                    <span className="badge chat-targets-qa-a-badge">A</span>
                    <span className="chat-targets-qa-a-text">
                      {truncateDisplayText(item.a.replace(/\s+/gu, " "), 18)}
                    </span>
                  </div>
                </div>
                <div className="chat-targets-item-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={mutatingTargets}
                    onClick={(): void => {
                      fillQaPairForEdit(item.q, item.a);
                      onScrollToTop?.();
                    }}
                  >
                    {t.chats.qaEditButton}
                  </button>
                  <button
                    type="button"
                    className="btn danger icon-btn"
                    disabled={mutatingTargets}
                    onClick={(): void => {
                      void removeQaPair(item.q);
                    }}
                  >
                    <TrashSvgIcon size={13} />
                    <span>{t.chats.qaDeleteButton}</span>
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}
