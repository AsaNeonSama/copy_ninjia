import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { VERBATIM_CONTEXT_MAX } from "../../../consts/aiChat/memory";
import {
  MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
  MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS,
} from "../../../consts/miniApp";
import type {
  MiniAppMessageItem,
  MiniAppMessagePage,
} from "../../../types/miniApp";
import { fetchMiniAppChatMessages } from "../api";
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

  const loadMessages: (nextPage: number, nextPageSize: number) => Promise<void> =
    useCallback(
      async (nextPage: number, nextPageSize: number): Promise<void> => {
        setLoading(true);
        try {
          const data: MiniAppMessagePage = await fetchMiniAppChatMessages(
            chatId,
            nextPage,
            nextPageSize
          );
          setPageData(data);
          if (data.page !== nextPage) {
            setPageNumber(data.page);
          }
        } catch (error: unknown) {
          const message: string =
            error instanceof Error ? error.message : String(error);
          onToast(`读取发言记录失败: ${message}`);
        } finally {
          setLoading(false);
        }
      },
      [chatId, onToast]
    );

  useEffect((): void => {
    void loadMessages(pageNumber, pageSize);
  }, [loadMessages, pageNumber, pageSize]);

  return (
    <div>
      <div className="toolbar">
        <button type="button" className="btn" onClick={onBack}>
          ← 返回群状态
        </button>
        <button
          type="button"
          className="btn"
          disabled={loading}
          onClick={(): void => {
            void loadMessages(pageNumber, pageSize);
          }}
        >
          刷新记录
        </button>
      </div>

      <div className="card">
        <div className="card-title">
          <span>
            {pageData?.title ?? `群 ${chatId}`} · 热发言记录
          </span>
          <span className="badge">
            共 {pageData?.total ?? 0} / {pageData?.maxCapacity ?? VERBATIM_CONTEXT_MAX} 条 · 第 {pageData?.page ?? pageNumber} / {pageData?.totalPages ?? 1} 页
          </span>
        </div>

        {loading && pageData === null
          ? <div className="empty">正在读取热发言记录…</div>
          : null}

        {pageData !== null && pageData.items.length === 0
          ? <div className="empty">当前群暂无热发言记录</div>
          : null}

        {pageData !== null
          ? pageData.items.map((item: Readonly<MiniAppMessageItem>): React.JSX.Element => (
            <div key={`${item.index}-${item.messageId}`} className="msg-item">
              <div className="msg-head">
                <span>
                  #{item.index + 1} · <strong>{item.name}</strong>
                  {item.username !== undefined ? ` @${item.username}` : ""}
                  {` (${item.userId})`}
                </span>
                <span>
                  msg#{item.messageId} · {item.at}
                </span>
              </div>
              {item.forwardedFrom !== undefined
                ? <div className="msg-quote">转发自: {item.forwardedFrom}</div>
                : null}
              {item.replyToPreview !== undefined
                ? (
                  <div className="msg-quote">
                    回复 {item.replyToName ?? `#${item.replyToMessageId ?? ""}`}: {item.replyToPreview}
                  </div>
                )
                : null}
              <div className="msg-body">{item.text}</div>
            </div>
          ))
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
