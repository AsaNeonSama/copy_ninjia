import { Fragment } from "react";
import type React from "react";
import { truncateDisplayText } from "../libs/formatters";
import type { MiniAppChatSummary } from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";

/** `ManagedChatList` 受管群卡片与操作按钮列表的属性参数。 */
export interface ManagedChatListProps {
  /** 当前页待展示的受管群摘要数组。 */
  readonly chats: readonly Readonly<MiniAppChatSummary>[];
  /** 列表当前是否正在刷新。 */
  readonly loadingList: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 点击某个群的「配置与开关」按钮进入详情页的回调。 */
  readonly onSelectChat: (chatId: number) => void;
}

/**
 * 渲染已启用 `/init` 的受管群摘要卡片与详情跳转按钮列表。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function ManagedChatList({
  chats,
  loadingList,
  t,
  onSelectChat,
}: ManagedChatListProps): React.JSX.Element {
  return (
    <Fragment>
      {chats.map((chat: Readonly<MiniAppChatSummary>): React.JSX.Element => {
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
                {chat.isLockdownActive || chat.features.proxySend ? (
                  <div
                    style={{
                      display: "flex",
                      gap: "4px",
                      flexWrap: "wrap",
                      marginTop: "6px",
                    }}
                  >
                    {chat.features.proxySend ? (
                      <span className="badge ok">/send</span>
                    ) : null}
                    {chat.isLockdownActive ? (
                      <span className="badge warn">{t.chats.lockdownBadge}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={(): void => {
                  onSelectChat(chat.chatId);
                }}
              >
                {t.chats.detailSectionTitle}
              </button>
            </div>
          </div>
        );
      })}
    </Fragment>
  );
}
