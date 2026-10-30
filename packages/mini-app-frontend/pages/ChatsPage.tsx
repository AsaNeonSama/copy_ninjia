import { Fragment, memo, useEffect } from "react";
import type React from "react";
import { CollapseGrid } from "../components/animations/CollapseGrid";
import { ChatFeatureListCard } from "../components/ChatFeatureListCard";
import { ChatJoinCleanCard } from "../components/ChatJoinCleanCard";
import { ChatTargetsMenuButtonList } from "../components/ChatTargetsMenuButtonList";
import { ChatTargetsModal } from "../components/ChatTargetsModal";
import { ManagedChatList } from "../components/ManagedChatList";
import { MessagesView } from "../components/MessagesView";
import { PaginationBar } from "../components/PaginationBar";
import { ChatDetailSkeleton } from "../components/skeletons/ChatDetailSkeleton";
import { ListSkeletonRows } from "../components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../components/skeletons/LoadingBox";
import {
  MINI_APP_BATCH_KICK_POLL_INTERVAL_MS,
  MINI_APP_CHATS_DEFAULT_PAGE_SIZE,
  MINI_APP_CHATS_PAGE_SIZE_OPTIONS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import { truncateDisplayText } from "../libs/formatters";
import {
  ArrowLeftSvgIcon,
  ChatsSvgIcon,
  ChevronDownSvgIcon,
  IdentitiesSvgIcon,
  RefreshSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createChatsStore } from "../store/chats";
import type { MiniAppChatsStoreState } from "../store/chats";
import type {
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppLanguage,
} from "../types/miniApp";

/** `BotPermTagGrid` 已授予 Bot 权限标签网格的属性参数（与 `botPermsExpanded` 隔离，展开/收起切换时不重排标签）。 */
interface BotPermTagGridProps {
  /** 已授予的 Bot 权限标识数组。 */
  readonly grantedLabels: readonly string[];
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
}

/**
 * 渲染已授予的 Bot 权限标签网格。
 *
 * @param props 权限标识数组与翻译字典
 * @returns React 节点
 */
function BotPermTagGridView({
  grantedLabels,
  t,
}: BotPermTagGridProps): React.JSX.Element {
  return (
    <div className="bot-perm-tag-grid">
      {grantedLabels.map(
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
  );
}

/** 按属性浅比较跳过重渲染的 Bot 权限标签网格组件。 */
const BotPermTagGrid: React.MemoExoticComponent<typeof BotPermTagGridView> =
  memo(BotPermTagGridView);

/** `ChatOverviewCard` 群概览与 Bot 权限折叠卡片的属性参数。 */
interface ChatOverviewCardProps {
  /** 当前群详情快照。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
  /** Bot 权限面板是否处于展开状态。 */
  readonly botPermsExpanded: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换 Bot 权限面板展开/收起的回调。 */
  readonly onToggleBotPerms: () => void;
}

/**
 * 渲染群详情页顶部的群标题、统计摘要与可折叠 Bot 权限卡片（与目标弹窗及表单输入状态隔离）。
 *
 * @param props 群详情、权限展开态、翻译字典与切换回调
 * @returns React 节点
 */
function ChatOverviewCardView({
  chatDetail,
  botPermsExpanded,
  t,
  onToggleBotPerms,
}: ChatOverviewCardProps): React.JSX.Element {
  return (
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
        : chatDetail.botPermissions.grantedLabels.length === 0
          ? (
            <div className="bot-perm-status-box">
              <span>{t.chats.botPermNone}</span>
            </div>
          )
          : (
            <div
              className={`bot-perm-granted-box ${botPermsExpanded ? "expanded" : ""}`}
            >
              <button
                type="button"
                className="bot-perm-granted-toggle"
                aria-expanded={botPermsExpanded}
                onClick={onToggleBotPerms}
              >
                <span className="bot-perm-granted-head-main">
                  <IdentitiesSvgIcon size={14} />
                  <span className="bot-perm-granted-title">
                    {t.chats.botPermGrantedTitle(
                      chatDetail.botPermissions.grantedLabels.length
                    )}
                  </span>
                </span>
                <span
                  className="bot-perm-chevron-pill"
                  aria-hidden="true"
                >
                  <ChevronDownSvgIcon
                    size={14}
                    className={`chevron-icon ${botPermsExpanded ? "rotated" : ""}`}
                  />
                </span>
              </button>
              <CollapseGrid
                expanded={botPermsExpanded}
                gridClassName="bot-perm-collapse-grid"
                innerClassName="bot-perm-collapse-inner"
              >
                <BotPermTagGrid
                  grantedLabels={chatDetail.botPermissions.grantedLabels}
                  t={t}
                />
              </CollapseGrid>
            </div>
          )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的群概览与 Bot 权限折叠卡片组件。 */
const ChatOverviewCard: React.MemoExoticComponent<typeof ChatOverviewCardView> =
  memo(ChatOverviewCardView);

/**
 * 已启用 `/init` 的群列表、群详细状态、进群统计与批量清理及功能开关页面（含热 256 条发言记录跳转）。
 *
 * @returns React 节点
 */
export function ChatsPage(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const storeState: MiniAppChatsStoreState = useComponentStore(createChatsStore);
  const {
    chats,
    loadingList,
    selectedChatId,
    chatDetail,
    loadingDetail,
    botPermsExpanded,
    togglingFeature,
    targetsMenuOpen,
    chatTargets,
    viewingMessages,
    chatPage,
    chatPageSize,
    loadChatList,
    selectChat,
    closeDetail,
    openMessages,
    closeMessages,
    toggleBotPerms,
    toggleTargetsMenu,
    closeTargetsMenu,
    openTargetsModal,
    toggleFeature,
    pollRunningBatchKick,
    cancelPendingRefresh,
    setChatPage,
    setChatPageSize,
  }: MiniAppChatsStoreState = storeState;

  useEffect((): (() => void) => {
    void loadChatList();
    return (): void => {
      cancelPendingRefresh();
    };
  }, [loadChatList, cancelPendingRefresh]);

  const batchKickRunning: boolean = chatDetail?.batchKickRunning === true;
  useEffect((): (() => void) | undefined => {
    if (selectedChatId === null || viewingMessages || !batchKickRunning) {
      return undefined;
    }
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      void pollRunningBatchKick();
    }, MINI_APP_BATCH_KICK_POLL_INTERVAL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [selectedChatId, viewingMessages, batchKickRunning, pollRunningBatchKick]);

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
        <div className="toolbar chat-detail-toolbar">
          <button
            type="button"
            className="btn icon-btn"
            onClick={closeDetail}
          >
            <ArrowLeftSvgIcon size={14} />
            <span>{t.chats.closeDetailButton}</span>
          </button>
          <div className="chat-detail-toolbar-right">
            <button
              type="button"
              className="btn primary icon-btn"
              onClick={openMessages}
            >
              <ChatsSvgIcon size={14} />
              <span>{t.chats.viewMessagesButton}</span>
            </button>
            <ChatTargetsMenuButtonList
              targetsMenuOpen={targetsMenuOpen}
              chatDetail={chatDetail}
              chatTargets={chatTargets}
              t={t}
              onToggleMenu={toggleTargetsMenu}
              onCloseMenu={closeTargetsMenu}
              onSelectTargetKind={openTargetsModal}
            />
          </div>
        </div>

        {loadingDetail && chatDetail === null
          ? <ChatDetailSkeleton />
          : null}

        {chatDetail !== null
          ? (
            <Fragment>
              <ChatOverviewCard
                chatDetail={chatDetail}
                botPermsExpanded={botPermsExpanded}
                t={t}
                onToggleBotPerms={toggleBotPerms}
              />

              <ChatJoinCleanCard chatDetail={chatDetail} state={storeState} />

              <ChatFeatureListCard
                chatDetail={chatDetail}
                togglingFeature={togglingFeature}
                language={language}
                t={t}
                onToggleFeature={toggleFeature}
              />
            </Fragment>
          )
          : null}
        <ChatTargetsModal state={storeState} />
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
            <ChatsSvgIcon size={16} />
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

      {loadingList
        ? (
          <LoadingBox className="card loading-box" text={t.chats.loadingChatsText}>
            <ListSkeletonRows count={MINI_APP_CHATS_DEFAULT_PAGE_SIZE} />
          </LoadingBox>
        )
        : null}

      {!loadingList && chats.length === 0
        ? <div className="card"><div className="empty">{t.chats.emptyChatsHint}</div></div>
        : null}

      {!loadingList && chats.length > 0
        ? (
          <ManagedChatList
            chats={pagedChats}
            t={t}
            onSelectChat={selectChat}
          />
        )
        : null}

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
