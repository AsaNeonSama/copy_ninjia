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
} from "../../../types/miniApp";
import {
  confirmMiniAppAction,
  fetchMiniAppChatDetail,
  fetchMiniAppChats,
  toggleMiniAppChatFeature,
} from "../api";
import { formatUptime, getFeatureDisplayMeta } from "../formatters";
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
      onToast(`加载群列表失败: ${message}`);
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
        onToast(`加载群详情失败: ${message}`);
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
      !confirmMiniAppAction(
        "关闭 /init 将清空该群的开关、问答、上下文记忆并从已初始化列表移除，确定继续？"
      )
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
      onToast(`开关操作失败: ${message}`);
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
      <section>
        <div className="toolbar">
          <button
            type="button"
            className="btn"
            onClick={(): void => {
              setSelectedChatId(null);
              setChatDetail(null);
              void loadChatList();
            }}
          >
            ← 返回群列表
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={(): void => {
              setViewingMessages(true);
            }}
          >
            查看热 256 条发言记录
          </button>
        </div>

        {loadingDetail && chatDetail === null
          ? <div className="card"><div className="empty">正在加载群详细状态…</div></div>
          : null}

        {chatDetail !== null
          ? (
            <>
              <div className="card">
                <div className="card-title">
                  <span>{chatDetail.title}</span>
                  <span className={`badge ${chatDetail.features.init ? "ok" : "warn"}`}>
                    {chatDetail.features.init ? "已 /init" : "已关闭 /init"}
                  </span>
                </div>
                <div className="row-sub" style={{ marginBottom: "10px" }}>
                  Chat ID: {chatDetail.chatId}
                  {chatDetail.botPermissions !== null &&
                  chatDetail.botPermissions.missingLabels.length > 0
                    ? ` · 缺失管理员权限: ${chatDetail.botPermissions.missingLabels.join("、")}`
                    : ""}
                </div>
                <div className="grid-2">
                  <div className="stat-box">
                    <div className="stat-label">热发言记录 (上限 {chatDetail.hotMessageMax})</div>
                    <div className="stat-value">
                      {chatDetail.hotMessageCount} / {chatDetail.hotMessageMax}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">问答词条 / 翻译目标</div>
                    <div className="stat-value">
                      {chatDetail.qaPairCount} 条 / {chatDetail.translateTargetCount} 人
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">防突袭封锁 / 入群待验</div>
                    <div className="stat-value">
                      {chatDetail.isLockdownActive
                        ? `封锁中 (${formatUptime(chatDetail.lockdownRemainingMs)})`
                        : "正常"}{" "}
                      · 待验 {chatDetail.activeSessions.verify}
                    </div>
                  </div>
                  <div className="stat-box">
                    <div className="stat-label">静默剩余 / 删消息目标</div>
                    <div className="stat-value">
                      {chatDetail.quietRemainingMs > 0
                        ? formatUptime(chatDetail.quietRemainingMs)
                        : "未静默"}{" "}
                      · 删消息 {chatDetail.deleteMessageTargetCount}
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-title">
                  <span>群功能开关控制 (含 /init)</span>
                </div>
                {MINI_APP_FEATURE_KEYS.map((key: MiniAppFeatureKey): React.JSX.Element => {
                  const enabled: boolean = chatDetail.features[key];
                  const meta: MiniAppFeatureDisplayMeta = getFeatureDisplayMeta(key);
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
    <section>
      <div className="toolbar">
        <span style={{ fontSize: "12px", color: "var(--hint)" }}>
          仅列出已执行 /init 的受管群 ({totalChats}) · 第 {safeChatPage} / {totalChatPages} 页
        </span>
        <button
          type="button"
          className="btn"
          onClick={(): void => {
            void loadChatList();
          }}
        >
          刷新群列表
        </button>
      </div>

      {loadingList && chats.length === 0
        ? <div className="card"><div className="empty">正在读取已初始化群列表…</div></div>
        : null}

      {!loadingList && chats.length === 0
        ? <div className="card"><div className="empty">当前没有已启用 /init 的群组</div></div>
        : null}

      {pagedChats.map((chat: Readonly<MiniAppChatSummary>): React.JSX.Element => {
        const enabledFeatureCount: number = MINI_APP_FEATURE_KEYS.filter(
          (key: MiniAppFeatureKey): boolean => chat.features[key]
        ).length;
        return (
          <div key={chat.chatId} className="card">
            <div className="row" style={{ padding: 0 }}>
              <div className="row-main">
                <div className="row-title">{chat.title}</div>
                <div className="row-sub">
                  ID: {chat.chatId} · 热发言: {chat.hotMessageCount}/256 · 问答: {chat.qaPairCount} · 已开功能: {enabledFeatureCount}/7
                </div>
                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "6px" }}>
                  {chat.features.proxySend ? <span className="badge ok">代理 /send 中</span> : null}
                  {chat.isLockdownActive ? <span className="badge warn">紧急封锁中</span> : null}
                </div>
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={(): void => {
                  handleSelectChat(chat.chatId);
                }}
              >
                详细状态
              </button>
            </div>
          </div>
        );
      })}

      {totalChats > 0
        ? (
          <PaginationBar
            page={safeChatPage}
            totalPages={totalChatPages}
            total={totalChats}
            pageSize={chatPageSize}
            pageSizeOptions={MINI_APP_CHATS_PAGE_SIZE_OPTIONS}
            unitLabel="个群"
            disabled={loadingList}
            onPageChange={(nextPage: number): void => {
              setChatPage(nextPage);
            }}
            onPageSizeChange={(nextPageSize: number): void => {
              setChatPage(1);
              setChatPageSize(nextPageSize);
            }}
          />
        )
        : null}
    </section>
  );
}
