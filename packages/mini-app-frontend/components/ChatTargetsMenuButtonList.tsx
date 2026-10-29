import { Fragment, memo } from "react";
import type React from "react";
import {
  MINI_APP_CHAT_TARGET_KINDS,
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
} from "../consts/miniApp";
import { ChevronDownSvgIcon } from "../resource";
import type {
  MiniAppChatDetail,
  MiniAppChatTargetKind,
  MiniAppChatTargetsView,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import { resolveTargetKindCounts } from "./ChatTargetsModal";

/** `ChatTargetsMenuButtonList` 群目标管理下拉按钮列表的属性参数。 */
export interface ChatTargetsMenuButtonListProps {
  /** 下拉菜单当前是否已展开。 */
  readonly targetsMenuOpen: boolean;
  /** 当前群详情（尚未加载完成时为 `null`）。 */
  readonly chatDetail: Readonly<MiniAppChatDetail> | null;
  /** 当前群目标详情快照（可选）。 */
  readonly chatTargets: Readonly<MiniAppChatTargetsView> | null;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换下拉菜单展开/收起的回调。 */
  readonly onToggleMenu: () => void;
  /** 关闭下拉菜单的回调。 */
  readonly onCloseMenu: () => void;
  /** 选择某个目标类别打开管理弹窗的回调。 */
  readonly onSelectTargetKind: (kind: MiniAppChatTargetKind) => void;
}

/**
 * 渲染群详情顶部工具栏中的「目标管理」下拉按钮及三类目标（问答对、删发言目标、翻译目标）按钮列表。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function ChatTargetsMenuButtonListView({
  targetsMenuOpen,
  chatDetail,
  chatTargets,
  t,
  onToggleMenu,
  onCloseMenu,
  onSelectTargetKind,
}: ChatTargetsMenuButtonListProps): React.JSX.Element {
  const {
    displayValue: displayMenuDetail,
    isClosing,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppChatDetail>>> =
    useDelayedUnmount(
      targetsMenuOpen && chatDetail !== null ? chatDetail : null,
      MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS
    );

  return (
    <div className="chat-targets-dropdown">
      <button
        type="button"
        className={`btn icon-btn chat-targets-menu-btn ${targetsMenuOpen ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={targetsMenuOpen}
        disabled={chatDetail === null}
        onClick={onToggleMenu}
      >
        <span>{t.chats.targetsMenuButton}</span>
        <ChevronDownSvgIcon
          size={14}
          className={`chevron-icon ${targetsMenuOpen ? "rotated" : ""}`}
        />
      </button>
      {displayMenuDetail !== null ? (
        <Fragment>
          <div
            className={`chat-targets-menu-backdrop ${isClosing ? "closing" : ""}`}
            aria-hidden="true"
            onClick={(): void => {
              if (!isClosing) {
                onCloseMenu();
              }
            }}
          />
          <div
            className={`chat-targets-menu-popover ${isClosing ? "closing" : ""}`}
            role="menu"
            aria-hidden={isClosing}
          >
            {MINI_APP_CHAT_TARGET_KINDS.map(
              (kind: MiniAppChatTargetKind): React.JSX.Element => {
                const [count, max]: readonly [number, number] =
                  resolveTargetKindCounts(kind, displayMenuDetail, chatTargets);
                return (
                  <button
                    key={kind}
                    type="button"
                    role="menuitem"
                    disabled={isClosing}
                    className="chat-targets-menu-item"
                    onClick={(): void => {
                      onSelectTargetKind(kind);
                    }}
                  >
                    <span className="chat-targets-menu-item-label">
                      {t.chats.targetsKindLabel[kind]}
                    </span>
                    <span className="chat-targets-menu-item-badge">
                      {`${count}/${max}`}
                    </span>
                  </button>
                );
              }
            )}
          </div>
        </Fragment>
      ) : null}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的目标管理下拉按钮组件。 */
export const ChatTargetsMenuButtonList: React.MemoExoticComponent<
  typeof ChatTargetsMenuButtonListView
> = memo(ChatTargetsMenuButtonListView);
