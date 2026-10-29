import { memo, useRef } from "react";
import type React from "react";
import { truncateDisplayText } from "../libs/formatters";
import { CloseSvgIcon, PlusSvgIcon, TrashSvgIcon } from "../resource";
import type { MiniAppChatsStoreState } from "../store/chats";
import type { MiniAppChatQaItem } from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { ChatTargetsListSkeleton } from "./skeletons/ChatTargetsListSkeleton";

/** `ChatTargetsQaItemList` 问答卡片列表的属性参数。 */
interface ChatTargetsQaItemListProps {
  /** 已配置的问答对列表。 */
  readonly qaItems: readonly Readonly<MiniAppChatQaItem>[];
  /** 当前是否正在提交目标变更。 */
  readonly mutatingTargets: boolean;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 将指定问答对填入顶部编辑区的回调。 */
  readonly onFillForEdit: (q: string, a: string) => void;
  /** 删除指定问答对的回调。 */
  readonly onRemoveQaPair: (q: string) => Promise<void>;
  /** 点击「编辑」后将弹窗滚动至顶部的回调。 */
  readonly onScrollToTop?: () => void;
}

/**
 * 渲染问答对卡片列表；与顶部折叠编辑表单状态隔离，使展开/收起编辑表单或输入文字时不重排列表项。
 *
 * @param props 列表属性
 * @returns React 节点
 */
function ChatTargetsQaItemListView({
  qaItems,
  mutatingTargets,
  t,
  onFillForEdit,
  onRemoveQaPair,
  onScrollToTop,
}: ChatTargetsQaItemListProps): React.JSX.Element {
  return (
    <div className="chat-targets-list">
      {qaItems.map(
        (item: Readonly<MiniAppChatQaItem>): React.JSX.Element => (
          <div
            key={item.q}
            className="chat-targets-item chat-targets-qa-item"
          >
            <div className="chat-targets-qa-head">
              <div className="chat-targets-qa-q">
                <span className="badge chat-targets-qa-q-badge">Q</span>
                <span className="chat-targets-qa-q-text" title={item.q}>
                  {truncateDisplayText(item.q.replace(/\s+/gu, " "), 72)}
                </span>
              </div>
              <div className="chat-targets-item-actions">
                <button
                  type="button"
                  className="btn chat-targets-qa-action-btn"
                  disabled={mutatingTargets}
                  onClick={(): void => {
                    onFillForEdit(item.q, item.a);
                    onScrollToTop?.();
                  }}
                >
                  {t.chats.qaEditButton}
                </button>
                <button
                  type="button"
                  className="btn danger icon-btn chat-targets-qa-action-btn"
                  disabled={mutatingTargets}
                  onClick={(): void => {
                    void onRemoveQaPair(item.q);
                  }}
                >
                  <TrashSvgIcon size={12} />
                  <span>{t.chats.qaDeleteButton}</span>
                </button>
              </div>
            </div>
            <div className="chat-targets-qa-a" title={item.a}>
              <span className="badge chat-targets-qa-a-badge">A</span>
              <span className="chat-targets-qa-a-text">
                {truncateDisplayText(item.a.replace(/\s+/gu, " "), 140)}
              </span>
            </div>
          </div>
        )
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的问答对列表组件。 */
const ChatTargetsQaItemList: React.MemoExoticComponent<
  typeof ChatTargetsQaItemListView
> = memo(ChatTargetsQaItemListView);

/** `ChatTargetsQaEditorForm` 问答对折叠编辑表单的属性参数。 */
export interface ChatTargetsQaEditorFormProps {
  /** `ChatsPage` 持有的状态与动作快照。 */
  readonly state: MiniAppChatsStoreState;
  /** 当前语言翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染问答对折叠编辑区内部的触发词与回答内容表单。
 *
 * @param props 仓库状态与翻译字典
 * @returns React 节点
 */
export function ChatTargetsQaEditorForm({
  state,
  t,
}: ChatTargetsQaEditorFormProps): React.JSX.Element {
  const {
    chatTargets,
    mutatingTargets,
    qaEditorOpen,
    qaQuestionInput,
    qaAnswerInput,
    closeQaEditor,
    setQaQuestionInput,
    setQaAnswerInput,
    submitQaPair,
  }: MiniAppChatsStoreState = state;

  const qaQuestionMaxChars: number = chatTargets?.qaQuestionMaxChars ?? 256;
  const qaAnswerMaxChars: number = chatTargets?.qaAnswerMaxChars ?? 3_840;
  const closingSnapshotRef: React.RefObject<{
    readonly q: string;
    readonly a: string;
    readonly mutating: boolean;
  }> = useRef<{
    readonly q: string;
    readonly a: string;
    readonly mutating: boolean;
  }>({
    q: qaQuestionInput,
    a: qaAnswerInput,
    mutating: mutatingTargets,
  });
  if (qaEditorOpen) {
    closingSnapshotRef.current = {
      q: qaQuestionInput,
      a: qaAnswerInput,
      mutating: mutatingTargets,
    };
  }
  const displayQuestion: string = qaEditorOpen
    ? qaQuestionInput
    : closingSnapshotRef.current.q;
  const displayAnswer: string = qaEditorOpen
    ? qaAnswerInput
    : closingSnapshotRef.current.a;
  const displayMutating: boolean = qaEditorOpen
    ? mutatingTargets
    : closingSnapshotRef.current.mutating;

  return (
    <div className="chat-targets-form chat-targets-form-qa">
      <div className="chat-targets-field">
        <div className="chat-targets-field-head">
          <span className="chat-targets-field-label">
            {t.chats.qaQuestionLabel}
          </span>
          <span className="chat-targets-field-counter">
            {`${displayQuestion.length}/${qaQuestionMaxChars}`}
          </span>
        </div>
        <input
          type="text"
          className="chat-targets-input"
          maxLength={qaQuestionMaxChars}
          placeholder={t.chats.qaQuestionPlaceholder(qaQuestionMaxChars)}
          value={displayQuestion}
          disabled={displayMutating}
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
            {`${displayAnswer.length}/${qaAnswerMaxChars}`}
          </span>
        </div>
        <textarea
          className="chat-targets-textarea"
          rows={3}
          maxLength={qaAnswerMaxChars}
          placeholder={t.chats.qaAnswerPlaceholder(qaAnswerMaxChars)}
          value={displayAnswer}
          disabled={displayMutating}
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
            displayMutating ||
            displayQuestion.trim().length === 0 ||
            displayAnswer.trim().length === 0
          }
          tabIndex={qaEditorOpen ? 0 : -1}
          onClick={(): void => {
            void submitQaPair();
          }}
        >
          <PlusSvgIcon size={14} />
          <span>
            {displayMutating ? t.chats.qaSavingButton : t.chats.qaSaveButton}
          </span>
        </button>
        <button
          type="button"
          className="btn icon-btn chat-targets-cancel-btn"
          disabled={displayMutating}
          tabIndex={qaEditorOpen ? 0 : -1}
          onClick={closeQaEditor}
        >
          <CloseSvgIcon size={14} />
          <span>{t.chats.qaCancelEditButton}</span>
        </button>
      </div>
    </div>
  );
}

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
 * 渲染群目标管理弹窗中的「问答对」列表面板。
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
    fillQaPairForEdit,
    removeQaPair,
  }: MiniAppChatsStoreState = state;

  if (loadingTargets) {
    return <ChatTargetsListSkeleton />;
  }
  if ((chatTargets?.qaItems.length ?? 0) === 0) {
    return <div className="empty">{t.chats.qaEmptyHint}</div>;
  }
  return (
    <ChatTargetsQaItemList
      qaItems={chatTargets!.qaItems}
      mutatingTargets={mutatingTargets}
      t={t}
      onFillForEdit={fillQaPairForEdit}
      onRemoveQaPair={removeQaPair}
      onScrollToTop={onScrollToTop}
    />
  );
}
