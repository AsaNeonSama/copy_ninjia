import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { VERBATIM_CONTEXT_MAX } from "../consts/memory";
import {
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS,
} from "../consts/miniApp";
import type {
  MiniAppLanguage,
  MiniAppMessageItem,
  MiniAppMessagePage,
} from "../types/miniApp";
import {
  ArrowLeftSvgIcon,
  ChatsSvgIcon,
  RefreshSvgIcon,
} from "../miniAppResoures";
import { fetchMiniAppChatMessages } from "../api";
import {
  truncateDisplayText,
  waitMinimumLoadingDuration,
} from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";
import { PaginationBar } from "./PaginationBar";

/** `MessagesView` 组件的属性参数。 */
export interface MessagesViewProps {
  /** 当前查看的群 ID。 */
  readonly chatId: number;
  /** 返回群详细状态页的回调。 */
  readonly onBack: () => void;
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

const AVATAR_TONE_COUNT: number = 6;

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
 * 按指定行数生成发言列表骨架占位卡片数组（含头像徽章、作者信息行与消息气泡骨架）。
 *
 * @param count 骨架卡片行数
 * @returns React 节点数组
 */
function renderMessageSkeletonRows(count: number): React.JSX.Element[] {
  const rows: React.JSX.Element[] = [];
  for (let i: number = 0; i < count; i += 1) {
    rows.push(
      <div key={i} className="skeleton-card msg-skeleton-card">
        <div className="msg-head">
          <div className="skeleton-line msg-skeleton-avatar" />
          <div className="msg-author-col">
            <div className="skeleton-row-between" style={{ marginBottom: 0 }}>
              <div className="skeleton-line" style={{ width: "46%", height: "12px" }} />
              <div className="skeleton-line" style={{ width: "36px", height: "14px" }} />
            </div>
            <div className="skeleton-line" style={{ width: "68%", height: "9px" }} />
          </div>
        </div>
        <div className="skeleton-line msg-skeleton-bubble" />
      </div>
    );
  }
  return rows;
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
  onToast,
}: MessagesViewProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [pageSize, setPageSize]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE);
  const [pageNumber, setPageNumber]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(1);
  const [pageData, setPageData]: [
    MiniAppMessagePage | null,
    React.Dispatch<React.SetStateAction<MiniAppMessagePage | null>>
  ] = useState<MiniAppMessagePage | null>(null);
  const [loading, setLoading]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(true);
  const requestSeqRef: React.RefObject<number> = useRef<number>(0);

  const loadMessages: (nextPage: number, nextPageSize: number) => Promise<void> =
    useCallback(
      async (nextPage: number, nextPageSize: number): Promise<void> => {
        const reqId: number = ++requestSeqRef.current;
        const startedAt: number = Date.now();
        setLoading(true);
        try {
          const data: MiniAppMessagePage = await fetchMiniAppChatMessages(
            chatId,
            nextPage,
            nextPageSize
          );
          await waitMinimumLoadingDuration(startedAt);
          if (reqId !== requestSeqRef.current) {
            return;
          }
          setPageData(data);
          if (data.page !== nextPage) {
            setPageNumber(data.page);
          }
        } catch (error: unknown) {
          await waitMinimumLoadingDuration(startedAt);
          if (reqId !== requestSeqRef.current) {
            return;
          }
          const message: string =
            error instanceof Error ? error.message : String(error);
          onToast(message);
        } finally {
          if (reqId === requestSeqRef.current) {
            setLoading(false);
          }
        }
      },
      [chatId, onToast]
    );

  useEffect((): void => {
    void loadMessages(pageNumber, pageSize);
  }, [loadMessages, pageNumber, pageSize]);

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
            void loadMessages(pageNumber, pageSize);
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
              <ChatsSvgIcon size={15} />
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
            <div className="loading-box">
              <div className="loading-text">{t.messages.loadingText}</div>
              <div className="skeleton-stack">
                {renderMessageSkeletonRows(MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE)}
              </div>
            </div>
          )
          : null}

        {pageData !== null && pageData.items.length === 0
          ? <div className="empty">{t.messages.emptyHint}</div>
          : null}

        {pageData !== null
          ? (
            <div className="msg-list">
              {pageData.items.map((item: Readonly<MiniAppMessageItem>): React.JSX.Element => {
                const toneIndex: number = Math.abs(item.userId) % AVATAR_TONE_COUNT;
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
          onPageChange={(nextPage: number): void => {
            setPageNumber(nextPage);
          }}
          onPageSizeChange={(nextPageSize: number): void => {
            setPageNumber(1);
            setPageSize(nextPageSize);
          }}
        />
      </div>
    </div>
  );
}
