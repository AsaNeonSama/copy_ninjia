import { useEffect } from "react";
import type React from "react";
import {
  MINI_APP_CHATS_DEFAULT_PAGE_SIZE,
  MINI_APP_CHATS_PAGE_SIZE_OPTIONS,
  MINI_APP_FEATURE_KEYS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  getFeatureDisplayMeta,
  truncateDisplayText,
} from "../libs/formatters";
import {
  ArrowLeftSvgIcon,
  ChatsSvgIcon,
  RefreshSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createChatsStore } from "../store/chats";
import type { MiniAppChatsStoreState } from "../store/chats";
import type {
  MiniAppChatSummary,
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppLanguage,
} from "../types/miniApp";
import { MessagesView } from "./MessagesView";
import { PaginationBar } from "./PaginationBar";
import { ChatDetailSkeleton } from "./skeletons/ChatDetailSkeleton";
import { ListSkeletonRows } from "./skeletons/ListSkeletonRows";
import { LoadingBox } from "./skeletons/LoadingBox";

/**
 * 已启用 `/init` 的群列表、群详细状态与功能开关组件（含热 256 条发言记录跳转）。
 *
 * @returns React 节点
 */
export function ChatsTab(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    chats,
    loadingList,
    selectedChatId,
    chatDetail,
    loadingDetail,
    togglingFeature,
    viewingMessages,
    chatPage,
    chatPageSize,
    loadChatList,
    selectChat,
    closeDetail,
    openMessages,
    closeMessages,
    toggleFeature,
    setChatPage,
    setChatPageSize,
  }: MiniAppChatsStoreState = useComponentStore(createChatsStore);

  useEffect((): void => {
    void loadChatList();
  }, [loadChatList]);

  if (selectedChatId !== null && viewingMessages) {
    return (
      <MessagesView
        chatId={selectedChatId}
        onBack={closeMessages}
      />
    );
  }

  if (selectedChatId !== null) {
    return (
      <section className="animate-fade-in">
        <div className="toolbar">
          <button
            type="button"
            className="btn icon-btn"
            onClick={closeDetail}
          >
            <ArrowLeftSvgIcon size={14} />
            <span>{t.chats.closeDetailButton}</span>
          </button>
          <button
            type="button"
            className="btn primary icon-btn"
            onClick={openMessages}
          >
            <ChatsSvgIcon size={14} />
            <span>
              {t.chats.viewMessagesButton(
                chatDetail?.hotMessageCount ?? 0,
                chatDetail?.hotMessageMax ?? 256
              )}
            </span>
          </button>
        </div>

        {loadingDetail && chatDetail === null
          ? <ChatDetailSkeleton />
          : null}

        {chatDetail !== null
          ? (
            <>
              <div className="card">
                <div className="card-title">
                  <span className="chat-title-ellipsis" title={chatDetail.title}>
                    {truncateDisplayText(chatDetail.title, 20)}
                  </span>
                  <span className={`badge ${chatDetail.features.init ? "ok" : "warn"}`}>
                    {chatDetail.features.init ? "/init ON" : "/init OFF"}
                  </span>
                </div>
                <div className="row-sub" style={{ marginBottom: "10px" }}>
                  {t.chats.detailStatsLine(chatDetail)}
                </div>
                {chatDetail.botPermissions === null
                  ? (
                    <div className="bot-perm-status-box">
                      <span>{t.chats.botPermProbing}</span>
                    </div>
                  )
                  : chatDetail.botPermissions.missingLabels.length === 0
                    ? (
                      <div className="bot-perm-status-box ready">
                        <span>{t.chats.botPermAllReady}</span>
                      </div>
                    )
                    : (
                      <div className="bot-perm-missing-box">
                        <div className="bot-perm-missing-head">
                          <span className="bot-perm-missing-title">
                            {t.chats.botPermMissingTitle(
                              chatDetail.botPermissions.missingLabels.length
                            )}
                          </span>
                        </div>
                        <div className="bot-perm-tag-grid">
                          {chatDetail.botPermissions.missingLabels.map(
                            (rawLabel: string): React.JSX.Element => (
                              <span key={rawLabel} className="bot-perm-tag">
                                <span className="bot-perm-tag-dot" />
                                <span className="bot-perm-tag-text">
                                  {t.chats.botPermLabel(rawLabel)}
                                </span>
                              </span>
                            )
                          )}
                        </div>
                      </div>
                    )}
              </div>

              <div className="card">
                <div className="card-title">
                  <span>{t.chats.featuresSectionTitle}</span>
                </div>
                {MINI_APP_FEATURE_KEYS.map((key: MiniAppFeatureKey): React.JSX.Element => {
                  const enabled: boolean = chatDetail.features[key];
                  const meta: MiniAppFeatureDisplayMeta = getFeatureDisplayMeta(key, language);
                  return (
                    <div key={key} className="row">
                      <div className="row-main">
                        <div className="row-title">
                          {meta.label}{" "}
                          <span className="badge">{meta.command}</span>
                        </div>
                        <div className="row-sub">{meta.description}</div>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={togglingFeature !== null}
                          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                            const nextChecked: boolean = (
                              event.currentTarget as unknown as { readonly checked: boolean }
                            ).checked;
                            void toggleFeature(key, nextChecked);
                          }}
                        />
                        <span className="slider" />
                      </label>
                    </div>
                  );
                })}
              </div>
            </>
          )
          : null}
      </section>
    );
  }

  const totalChats: number = chats.length;
  const totalChatPages: number = Math.max(1, Math.ceil(totalChats / chatPageSize));
  const safeChatPage: number = Math.min(totalChatPages, Math.max(1, chatPage));
  const pagedChats: readonly Readonly<MiniAppChatSummary>[] = chats.slice(
    (safeChatPage - 1) * chatPageSize,
    safeChatPage * chatPageSize
  );

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <ChatsSvgIcon size={15} />
          </span>
          <span>{t.chats.sectionTitle(totalChats)}</span>
        </span>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loadingList}
          onClick={(): void => {
            void loadChatList();
          }}
        >
          <RefreshSvgIcon size={14} className={loadingList ? "spin-icon" : ""} />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {loadingList && chats.length === 0
        ? (
          <LoadingBox className="card loading-box" text={t.chats.loadingChatsText}>
            <ListSkeletonRows count={MINI_APP_CHATS_DEFAULT_PAGE_SIZE} />
          </LoadingBox>
        )
        : null}

      {!loadingList && chats.length === 0
        ? <div className="card"><div className="empty">{t.chats.emptyChatsHint}</div></div>
        : null}

      {pagedChats.map((chat: Readonly<MiniAppChatSummary>): React.JSX.Element => {
        const metaText: string = t.chats.chatCardMeta(
          chat.chatId,
          chat.hotMessageCount,
          chat.qaPairCount
        );
        return (
          <div
            key={chat.chatId}
            className={`card interactive-card ${loadingList ? "content-refreshing" : ""}`}
          >
            <div className="row" style={{ padding: 0 }}>
              <div className="row-main">
                <div className="row-title chat-title-ellipsis" title={chat.title}>
                  {truncateDisplayText(chat.title, 18)}
                </div>
                <div className="row-sub identity-sub-row" title={metaText}>
                  {metaText}
                </div>
                {chat.isLockdownActive || chat.features.proxySend
                  ? (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "6px" }}>
                      {chat.features.proxySend ? <span className="badge ok">/send</span> : null}
                      {chat.isLockdownActive ? <span className="badge warn">{t.chats.lockdownBadge}</span> : null}
                    </div>
                  )
                  : null}
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={(): void => {
                  selectChat(chat.chatId);
                }}
              >
                {t.chats.detailSectionTitle}
              </button>
            </div>
          </div>
        );
      })}

      {totalChats > 0
        ? (
          <div className="card">
            <PaginationBar
              page={safeChatPage}
              totalPages={totalChatPages}
              total={totalChats}
              pageSize={chatPageSize}
              pageSizeOptions={MINI_APP_CHATS_PAGE_SIZE_OPTIONS}
              disabled={loadingList}
              onPageChange={setChatPage}
              onPageSizeChange={setChatPageSize}
            />
          </div>
        )
        : null}
    </section>
  );
}
