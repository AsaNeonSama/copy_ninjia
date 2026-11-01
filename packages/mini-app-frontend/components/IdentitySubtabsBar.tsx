import { memo } from "react";
import type React from "react";
import { IdentitiesSvgIcon, RefreshSvgIcon } from "../resource";
import type { MiniAppIdentitySubTabKey } from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";

/** `IdentitySubtabsBar` 黑白名单子页签与刷新按钮栏的属性参数。 */
export interface IdentitySubtabsBarProps {
  /** 当前选中的子标签页（`"whitelist"` 或 `"blocklist"`）。 */
  readonly subTab: MiniAppIdentitySubTabKey;
  /** 名单当前是否正在加载。 */
  readonly loadingList: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换子标签页的回调。 */
  readonly onSelectSubTab: (subTab: MiniAppIdentitySubTabKey) => void;
  /** 点击刷新按钮的回调。 */
  readonly onRefresh: () => void;
}

/**
 * 渲染黑白名单页面顶部的子页签切换按钮组与刷新按钮栏。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function IdentitySubtabsBarView({
  subTab,
  loadingList,
  t,
  onSelectSubTab,
  onRefresh,
}: IdentitySubtabsBarProps): React.JSX.Element {
  return (
    <div className="subtabs-bar">
      <div className="subtabs-group">
        <button
          type="button"
          className={`subtab-btn ${subTab === "whitelist" ? "active" : ""}`}
          onClick={(): void => {
            onSelectSubTab("whitelist");
          }}
        >
          <IdentitiesSvgIcon size={14} />
          <span>{t.identities.whitelistTab}</span>
        </button>
        <button
          type="button"
          className={`subtab-btn danger-tab ${subTab === "blocklist" ? "active" : ""}`}
          onClick={(): void => {
            onSelectSubTab("blocklist");
          }}
        >
          <span>{t.identities.blocklistTab}</span>
        </button>
      </div>
      <button
        type="button"
        className="btn icon-btn"
        disabled={loadingList}
        onClick={onRefresh}
      >
        <RefreshSvgIcon size={14} className={loadingList ? "spin-icon" : ""} />
        <span>{t.chats.refreshButton}</span>
      </button>
    </div>
  );
}

/** 按属性浅比较跳过重渲染的黑白名单顶部子页签与刷新按钮栏。 */
export const IdentitySubtabsBar: React.MemoExoticComponent<
  typeof IdentitySubtabsBarView
> = memo(IdentitySubtabsBarView);
