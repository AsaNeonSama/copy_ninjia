import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  MINI_APP_CHATS_DEFAULT_PAGE_SIZE,
  MINI_APP_CHATS_PAGE_SIZE_OPTIONS,
  MINI_APP_FEATURE_KEYS,
} from "../../../consts/miniApp";
import type {
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppLanguage,
} from "../../../types/miniApp";
import {
  ArrowLeftSvgIcon,
  ChatsSvgIcon,
  RefreshSvgIcon,
} from "../../miniAppResoures";
import {
  fetchMiniAppChatDetail,
  fetchMiniAppChats,
  toggleMiniAppChatFeature,
} from "../api";
import { getFeatureDisplayMeta } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";
import { MessagesView } from "./MessagesView";
import { PaginationBar } from "./PaginationBar";

/** `ChatsTab` 组件的属性参数。 */
export interface ChatsTabProps {
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * 已启用 `/init` 的群列表、群详细状态与功能开关组件（含热 256 条发言记录跳转）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function ChatsTab({ onToast }: ChatsTabProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const requestConfirm: (
    message: string,
    tone?: "danger" | "primary"
  ) => Promise<boolean> = useMiniAppStore(
    (state: MiniAppUiStoreState): ((message: string, tone?: "danger" | "primary") => Promise<boolean>) =>
      state.requestConfirm
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [chats, setChats]: [
    readonly Readonly<MiniAppChatSummary>[],
    React.Dispatch<React.SetStateAction<readonly Readonly<MiniAppChatSummary>[]>>
  ] = useState<readonly Readonly<MiniAppChatSummary>[]>([]);
  const [loadingList, setLoadingList]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(true);
  const [selectedChatId, setSelectedChatId]: [
    number | null,
    React.Dispatch<React.SetStateAction<number | null>>
  ] = useState<number | null>(null);
  const [chatDetail, setChatDetail]: [
    MiniAppChatDetail | null,
    React.Dispatch<React.SetStateAction<MiniAppChatDetail | null>>
  ] = useState<MiniAppChatDetail | null>(null);
  const [loadingDetail, setLoadingDetail]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [togglingFeature, setTogglingFeature]: [
    MiniAppFeatureKey | null,
    React.Dispatch<React.SetStateAction<MiniAppFeatureKey | null>>
  ] = useState<MiniAppFeatureKey | null>(null);
  const [viewingMessages, setViewingMessages]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [chatPage, setChatPage]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(1);
  const [chatPageSize, setChatPageSize]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(MINI_APP_CHATS_DEFAULT_PAGE_SIZE);

  const loadChatList: () => Promise<void> = useCallback(async (): Promise<void> => {
    setLoadingList(true);
    try {
      const items: readonly Readonly<MiniAppChatSummary>[] = await fetchMiniAppChats();
      setChats(items);
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setLoadingList(false);
    }
  }, [onToast]);

  const loadDetail: (chatId: number) => Promise<void> = useCallback(
    async (chatId: number): Promise<void> => {
      setLoadingDetail(true);
      try {
        const detail: MiniAppChatDetail = await fetchMiniAppChatDetail(chatId);
        setChatDetail(detail);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        onToast(message);
      } finally {
        setLoadingDetail(false);
      }
    },
    [onToast]
  );

  useEffect((): void => {
    void loadChatList();
  }, [loadChatList]);

  const handleSelectChat = (chatId: number): void => {
    setSelectedChatId(chatId);
    setViewingMessages(false);
    setChatDetail(null);
    void loadDetail(chatId);
  };

  const handleToggleFeature = async (
    feature: MiniAppFeatureKey,
    enabled: boolean
  ): Promise<void> => {
    if (selectedChatId === null) return;
    if (
      feature === "init" &&
      !enabled &&
      !(await requestConfirm(t.chats.confirmDisableInit, "danger"))
    ) {
      return;
    }
    setTogglingFeature(feature);
    try {
      const result: MiniAppFeatureToggleResult = await toggleMiniAppChatFeature(
        selectedChatId,
        feature,
        enabled
      );
      onToast(result.message);
      if (result.removedFromList || result.detail === null) {
        setSelectedChatId(null);
        setChatDetail(null);
        void loadChatList();
      } else {
        setChatDetail(result.detail);
      }
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setTogglingFeature(null);
    }
  };

  if (selectedChatId !== null && viewingMessages) {
    return (
      <MessagesView
        chatId={selectedChatId}
        onBack={(): void => {
          setViewingMessages(false);
          void loadDetail(selectedChatId);
        }}
        onToast={onToast}
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
            onClick={(): void => {
              setSelectedChatId(null);
              setChatDetail(null);
              void loadChatList();
            }}
          >
            <ArrowLeftSvgIcon size={14} />
            <span>{t.chats.closeDetailButton}</span>
          </button>
          <button
            type="button"
            className="btn primary icon-btn"
            onClick={(): void => {
              setViewingMessages(true);
            }}
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
          ? (
            <div className="card loading-box">
              <div className="spinner-ring" />
              <div className="loading-text">{t.chats.loadingChatsText}</div>
            </div>
          )
          : null}

        {chatDetail !== null
          ? (
            <>
              <div className="card">
                <div className="card-title">
                  <span>{chatDetail.title}</span>
                  <span className={`badge ${chatDetail.features.init ? "ok" : "warn"}`}>
                    {chatDetail.features.init ? "/init ON♡" : "/init OFF"}
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
                            void handleToggleFeature(key, nextChecked);
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
          <div className="card loading-box">
            <div className="spinner-ring" />
            <div className="loading-text">{t.chats.loadingChatsText}</div>
          </div>
        )
        : null}

      {!loadingList && chats.length === 0
        ? <div className="card"><div className="empty">{t.chats.emptyChatsHint}</div></div>
        : null}

      {pagedChats.map((chat: Readonly<MiniAppChatSummary>): React.JSX.Element => (
        <div key={chat.chatId} className="card interactive-card">
          <div className="row" style={{ padding: 0 }}>
            <div className="row-main">
              <div className="row-title">{chat.title}</div>
              <div className="row-sub">
                {t.chats.chatCardMeta(chat.chatId, chat.hotMessageCount, chat.qaPairCount)}
              </div>
              {chat.isLockdownActive || chat.features.proxySend
                ? (
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "6px" }}>
                    {chat.features.proxySend ? <span className="badge ok">/send♡</span> : null}
                    {chat.isLockdownActive ? <span className="badge warn">{t.chats.lockdownBadge}</span> : null}
                  </div>
                )
                : null}
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={(): void => {
                handleSelectChat(chat.chatId);
              }}
            >
              {t.chats.detailSectionTitle}
            </button>
          </div>
        </div>
      ))}

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
              onPageChange={(nextPage: number): void => {
                setChatPage(nextPage);
              }}
              onPageSizeChange={(nextPageSize: number): void => {
                setChatPage(1);
                setChatPageSize(nextPageSize);
              }}
            />
          </div>
        )
        : null}
    </section>
  );
}
