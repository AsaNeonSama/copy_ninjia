import type React from "react";
import { WHITELIST_PERMISSION_KEYS } from "../consts/whitelist";
import {
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import { TrashSvgIcon } from "../resource";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { CollapseGrid } from "./animations/CollapseGrid";
import { PermissionDrawer } from "./PermissionDrawer";

/** `WhitelistEntryRowList` 白名单条目与操作按钮列表的属性参数。 */
export interface WhitelistEntryRowListProps {
  /** 当前页的白名单条目数组。 */
  readonly items: readonly Readonly<MiniAppWhitelistEntryView>[];
  /** 十八项白名单权限键与描述列表。 */
  readonly permissionDescriptors: readonly Readonly<MiniAppPermissionDescriptor>[];
  /** 当前展开权限抽屉的目标身份 ID（未展开时为 `null`）。 */
  readonly selectedEntryId: number | null;
  /** 列表当前是否正在刷新。 */
  readonly loadingList: boolean;
  /** 当前是否有增删操作在途。 */
  readonly busyAction: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换某个条目权限配置抽屉展开/收起的回调。 */
  readonly onTogglePermissionDrawer: (id: number) => void;
  /** 关闭权限配置抽屉的回调。 */
  readonly onClosePermissionDrawer: () => void;
  /** 权限配置更新后的刷新回调。 */
  readonly onPermissionsUpdated: () => void;
  /** 移除指定白名单条目的回调。 */
  readonly onRemoveWhitelist: (
    entry: Readonly<MiniAppWhitelistEntryView>
  ) => Promise<void>;
}

/**
 * 渲染白名单成员列表行及每行的「配置权限」「移出」按钮组与内联展开抽屉。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function WhitelistEntryRowList({
  items,
  permissionDescriptors,
  selectedEntryId,
  loadingList,
  busyAction,
  t,
  onTogglePermissionDrawer,
  onClosePermissionDrawer,
  onPermissionsUpdated,
  onRemoveWhitelist,
}: WhitelistEntryRowListProps): React.JSX.Element {
  return (
    <>
      {items.map(
        (entry: Readonly<MiniAppWhitelistEntryView>): React.JSX.Element => {
          const enabledCount: number = WHITELIST_PERMISSION_KEYS.filter(
            (key: WhitelistPermissionKey): boolean => entry.permissions[key]
          ).length;
          const isExpanded: boolean = selectedEntryId === entry.id;
          const permSubText: string = `ID: ${entry.id} · ${t.identities.enabledPermCountText(
            enabledCount,
            WHITELIST_PERMISSION_KEYS.length
          )}`;
          return (
            <div
              key={entry.id}
              className={`identity-row-group ${loadingList ? "content-refreshing" : ""}`}
            >
              <div className="row identity-row">
                <div className="row-main">
                  <div className="identity-title-row">
                    <bdi
                      className="identity-name"
                      title={sanitizeBidiText(entry.displayName)}
                    >
                      {truncateDisplayText(
                        entry.displayName,
                        entry.username !== undefined ? 8 : 13
                      )}
                    </bdi>
                    {entry.username !== undefined ? (
                      <span
                        className="identity-username"
                        dir="ltr"
                        title={`@${sanitizeBidiText(entry.username)}`}
                      >
                        @{truncateDisplayText(entry.username, 9)}
                      </span>
                    ) : null}
                    <span
                      className={`badge ${
                        entry.isChannel
                          ? "identity-channel-badge"
                          : "identity-user-badge"
                      }`}
                    >
                      {entry.isChannel
                        ? t.identities.channelBadge
                        : t.identities.userBadge}
                    </span>
                  </div>
                  <div className="row-sub identity-sub-row" title={permSubText}>
                    {permSubText}
                  </div>
                </div>
                <div className="toolbar-actions identity-row-actions">
                  <button
                    type="button"
                    className={`btn ${isExpanded ? "primary" : ""}`}
                    aria-expanded={isExpanded}
                    onClick={(): void => {
                      onTogglePermissionDrawer(entry.id);
                    }}
                  >
                    {t.identities.configurePermButton}
                  </button>
                  <button
                    type="button"
                    className="btn danger icon-btn"
                    disabled={busyAction}
                    onClick={(): void => {
                      void onRemoveWhitelist(entry);
                    }}
                  >
                    <TrashSvgIcon size={14} />
                    <span>{t.identities.removeWhitelistButton}</span>
                  </button>
                </div>
              </div>
              <CollapseGrid
                expanded={isExpanded}
                gridClassName="perm-drawer-collapse-grid"
                innerClassName="perm-drawer-collapse-inner"
              >
                <PermissionDrawer
                  entry={entry}
                  descriptors={permissionDescriptors}
                  onUpdated={onPermissionsUpdated}
                  onClose={onClosePermissionDrawer}
                />
              </CollapseGrid>
            </div>
          );
        }
      )}
    </>
  );
}

/** `BlocklistEntryRowList` 黑名单条目与操作按钮列表的属性参数。 */
export interface BlocklistEntryRowListProps {
  /** 当前页的黑名单条目数组。 */
  readonly items: readonly Readonly<MiniAppBlocklistEntryView>[];
  /** 列表当前是否正在刷新。 */
  readonly loadingList: boolean;
  /** 当前是否有增删操作在途。 */
  readonly busyAction: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 解封并移除指定黑名单条目的回调。 */
  readonly onRemoveBlocklist: (
    entry: Readonly<MiniAppBlocklistEntryView>
  ) => Promise<void>;
}

/**
 * 渲染黑名单成员列表行及每行的「解封」操作按钮。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function BlocklistEntryRowList({
  items,
  loadingList,
  busyAction,
  t,
  onRemoveBlocklist,
}: BlocklistEntryRowListProps): React.JSX.Element {
  return (
    <>
      {items.map(
        (entry: Readonly<MiniAppBlocklistEntryView>): React.JSX.Element => {
          const blockSubText: string = `ID: ${entry.id} · ${t.identities.blockedAtText(entry.blockedAt)}`;
          return (
            <div
              key={entry.id}
              className={`row identity-row ${loadingList ? "content-refreshing" : ""}`}
            >
              <div className="row-main">
                <div className="identity-title-row">
                  <bdi
                    className="identity-name"
                    title={sanitizeBidiText(entry.displayName)}
                  >
                    {truncateDisplayText(
                      entry.displayName,
                      entry.username !== undefined ? 11 : 16
                    )}
                  </bdi>
                  {entry.username !== undefined ? (
                    <span
                      className="identity-username"
                      dir="ltr"
                      title={`@${sanitizeBidiText(entry.username)}`}
                    >
                      @{truncateDisplayText(entry.username, 11)}
                    </span>
                  ) : null}
                  <span
                    className={`badge ${
                      entry.isChannel
                        ? "identity-channel-badge"
                        : "identity-user-badge"
                    }`}
                  >
                    {entry.isChannel
                      ? t.identities.channelBadge
                      : t.identities.userBadge}
                  </span>
                </div>
                <div className="row-sub identity-sub-row" title={blockSubText}>
                  {blockSubText}
                </div>
              </div>
              <div className="toolbar-actions identity-row-actions">
                <button
                  type="button"
                  className="btn danger icon-btn"
                  disabled={busyAction}
                  onClick={(): void => {
                    void onRemoveBlocklist(entry);
                  }}
                >
                  <TrashSvgIcon size={14} />
                  <span>{t.identities.removeBlocklistButton}</span>
                </button>
              </div>
            </div>
          );
        }
      )}
    </>
  );
}
