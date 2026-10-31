import { Fragment, memo } from "react";
import type React from "react";
import {
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import type { MiniAppChatSummary } from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";

/** `ManagedChatList` 受管群列表行与操作按钮列表的属性参数。 */
export interface ManagedChatListProps {
  /** 当前页待展示的受管群摘要数组。 */
  readonly chats: readonly Readonly<MiniAppChatSummary>[];
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 点击某个群的「配置与开关」按钮进入详情页的回调。 */
  readonly onSelectChat: (chatId: number) => void;
}

/**
 * 渲染已启用 `/init` 的受管群摘要列表行与详情跳转按钮。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function ManagedChatListView({
  chats,
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
            className="row identity-row"
          >
            <div className="row-main">
              <div className="identity-title-row">
                <bdi
                  className="identity-name"
                  title={sanitizeBidiText(chat.title)}
                >
                  {truncateDisplayText(chat.title, 18)}
                </bdi>
                {chat.features.proxySend ? (
                  <span className="badge ok">/send</span>
                ) : null}
                {chat.isLockdownActive ? (
                  <span className="badge warn">{t.chats.lockdownBadge}</span>
                ) : null}
              </div>
              <div className="row-sub identity-sub-row" title={metaText}>
                {metaText}
              </div>
            </div>
            <div className="toolbar-actions identity-row-actions">
              <button
                type="button"
                className="btn"
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

/** 按属性浅比较跳过重渲染的受管群摘要列表行组件。 */
export const ManagedChatList: React.MemoExoticComponent<
  typeof ManagedChatListView
> = memo(ManagedChatListView);
