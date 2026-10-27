import { useEffect } from "react";
import type React from "react";
import { VERBATIM_CONTEXT_MAX } from "../consts/memory";
import {
  MINI_APP_MESSAGE_AVATAR_TONE_COUNT,
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { truncateDisplayText } from "../libs/formatters";
import {
  ArrowLeftSvgIcon,
  ChatsSvgIcon,
  RefreshSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createMessagesStore } from "../store/messages";
import type { MiniAppMessagesStoreState } from "../store/messages";
import type {
  MiniAppLanguage,
  MiniAppMessageItem,
} from "../types/miniApp";
import { PaginationBar } from "./PaginationBar";
import { LoadingBox } from "./skeletons/LoadingBox";
import { MessageSkeletonRows } from "./skeletons/MessageSkeletonRows";

/** `MessagesView` 组件的属性参数。 */
export interface MessagesViewProps {
  /** 当前查看的群 ID。 */
  readonly chatId: number;
  /** 返回群详细状态页的回调。 */
  readonly onBack: () => void;
}

/**
 * 提取发言者显示名称的首个字符用于头像徽章展示。
 *
 * @param name 发言者显示名
 * @returns 单个大写首字符
 */
function extractAvatarInitial(name: string): string {
  const trimmed: string = name.trim();
  if (trimmed.length === 0) {
    return "#";
  }
  const firstChar: string | undefined = Array.from(trimmed)[0];
  return firstChar !== undefined ? firstChar.toUpperCase() : "#";
}

/**
 * 群热 256 条发言记录按条查看组件（默认 10 条/页，支持 10/15/20 档位切换，不展示压缩记忆摘要）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function MessagesView({
  chatId,
  onBack,
}: MessagesViewProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    pageSize,
    pageNumber,
    pageData,
    loading,
    loadMessages,
    setPageNumber,
    setPageSize,
  }: MiniAppMessagesStoreState = useComponentStore(createMessagesStore);

  useEffect((): void => {
    void loadMessages(chatId, pageNumber, pageSize);
  }, [chatId, loadMessages, pageNumber, pageSize]);

  return (
    <div className="animate-fade-in">
      <div className="toolbar">
        <button type="button" className="btn icon-btn" onClick={onBack}>
          <ArrowLeftSvgIcon size={14} />
          <span>{t.messages.backButton}</span>
        </button>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loading}
          onClick={(): void => {
            void loadMessages(chatId, pageNumber, pageSize);
          }}
        >
          <RefreshSvgIcon size={14} className={loading ? "spin-icon" : ""} />
          <span>{t.messages.refreshButton}</span>
        </button>
      </div>

      <div className="card">
        <div className="card-title">
          <span className="toolbar-hint" style={{ minWidth: 0, flex: 1 }}>
            <span className="toolbar-icon-badge">
              <ChatsSvgIcon size={16} />
            </span>
            <span
              className="chat-title-ellipsis"
              title={pageData?.title ?? `${chatId}`}
            >
              {t.messages.headerTitle(
                truncateDisplayText(pageData?.title ?? `${chatId}`, 18),
                pageData?.total ?? 0,
                pageData?.maxCapacity ?? VERBATIM_CONTEXT_MAX
              )}
            </span>
          </span>
          <span className="badge ok">
            {pageData?.total ?? 0} / {pageData?.maxCapacity ?? VERBATIM_CONTEXT_MAX}
          </span>
        </div>
        <div className="row-sub" style={{ marginBottom: "10px" }}>
          {t.messages.headerMeta(chatId)}
        </div>

        {loading && pageData === null
          ? (
            <LoadingBox text={t.messages.loadingText}>
              <MessageSkeletonRows count={MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE} />
            </LoadingBox>
          )
          : null}

        {pageData !== null && pageData.items.length === 0
          ? <div className="empty">{t.messages.emptyHint}</div>
          : null}

        {pageData !== null
          ? (
            <div className="msg-list">
              {pageData.items.map((item: Readonly<MiniAppMessageItem>): React.JSX.Element => {
                const toneIndex: number = Math.abs(item.userId) % MINI_APP_MESSAGE_AVATAR_TONE_COUNT;
                return (
                  <div
                    key={`${item.index}-${item.messageId}`}
                    className={`msg-item tone-${toneIndex} ${loading ? "content-refreshing" : ""}`}
                  >
                    <div className="msg-head">
                      <div
                        className={`msg-avatar tone-${toneIndex}`}
                        aria-hidden="true"
                      >
                        {extractAvatarInitial(item.name)}
                      </div>
                      <div className="msg-author-col">
                        <div className="msg-author-top">
                          <span
                            className="msg-author-wrap"
                            title={`${item.name}${item.username !== undefined ? ` @${item.username}` : ""} (${item.userId})`}
                          >
                            <strong className="msg-author-name">
                              {truncateDisplayText(item.name, 14)}
                            </strong>
                            {item.username !== undefined
                              ? (
                                <span className="msg-author-handle">
                                  {`@${truncateDisplayText(item.username, 11)}`}
                                </span>
                              )
                              : null}
                          </span>
                          <span className="msg-seq-pill">#{item.index + 1}</span>
                        </div>
                        <div className="msg-meta-row">
                          <span className="msg-meta-chip">UID {item.userId}</span>
                          <span className="msg-meta-chip">msg#{item.messageId}</span>
                          <span className="msg-meta-time">{item.at}</span>
                        </div>
                      </div>
                    </div>
                    {item.forwardedFrom !== undefined
                      ? (
                        <div className="msg-quote forward" title={item.forwardedFrom}>
                          {t.messages.forwardBadge(
                            truncateDisplayText(item.forwardedFrom, 20)
                          )}
                        </div>
                      )
                      : null}
                    {item.replyToPreview !== undefined
                      ? (
                        <div className="msg-quote reply">
                          {t.messages.replyBadge(
                            truncateDisplayText(
                              item.replyToName ?? `#${item.replyToMessageId ?? ""}`,
                              14
                            ),
                            item.replyToPreview
                          )}
                        </div>
                      )
                      : null}
                    <div
                      className={`msg-body ${item.text.length === 0 ? "empty-media" : ""}`}
                    >
                      {item.text.length > 0
                        ? item.text
                        : t.messages.emptyMediaPlaceholder}
                    </div>
                  </div>
                );
              })}
            </div>
          )
          : null}

        <PaginationBar
          page={pageData?.page ?? pageNumber}
          totalPages={pageData?.totalPages ?? 1}
          total={pageData?.total ?? 0}
          pageSize={pageData?.pageSize ?? pageSize}
          pageSizeOptions={MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS}
          disabled={loading}
          onPageChange={setPageNumber}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
}
