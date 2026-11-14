import { Fragment, memo, useCallback, useMemo, useRef } from "react";
import type React from "react";
import { MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS } from "../consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../consts/whitelist";
import {
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import { TrashSvgIcon } from "../resource";
import type {
  MiniAppBlocklistEntryView,
  MiniAppWhitelistEntryView,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { CollapseGrid } from "./animations/CollapseGrid";
import { resolveExpandFollowScrollTarget } from "./animations/expandFollowScroll";
import type {
  ViewportAnchorScrollTarget,
  ViewportRectElement,
} from "./animations/expandFollowScroll";
import type {
  FlipAnimatableElement,
  FlipFollowScrollResolver,
} from "./animations/flipCollapse";
import { useDelayedUnmount } from "./animations/useDelayedUnmount";
import type { DelayedUnmountState } from "./animations/useDelayedUnmount";
import { PermissionDrawer } from "./PermissionDrawer";

/** 按属性浅比较跳过重渲染的权限配置抽屉：切换行展开/收起时跳过内部 18 项权限卡片重调和。 */
const MemoizedPermissionDrawer: React.MemoExoticComponent<
  typeof PermissionDrawer
> = memo(PermissionDrawer);

/** `WhitelistEntryRowList` 白名单条目与操作按钮列表的属性参数。 */
export interface WhitelistEntryRowListProps {
  /** 当前页的白名单条目数组。 */
  readonly items: readonly Readonly<MiniAppWhitelistEntryView>[];
  /** 当前展开权限抽屉的目标身份 ID（未展开时为 `null`）。 */
  readonly selectedEntryId: number | null;
  /** 处于抽屉收起保留期的已移出白名单条目 ID（无保留行时为 `null` 或缺省）。 */
  readonly closingEntryId?: number | null;
  /** 当前是否有增删操作在途。 */
  readonly busyAction: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换某个条目权限配置抽屉展开/收起的回调。 */
  readonly onTogglePermissionDrawer: (id: number) => void;
  /** 关闭权限配置抽屉的回调。 */
  readonly onClosePermissionDrawer: () => void;
  /** 权限配置更新后的刷新回调。 */
  readonly onPermissionsUpdated: () => Promise<void> | void;
  /** 移除指定白名单条目的回调。 */
  readonly onRemoveWhitelist: (
    entry: Readonly<MiniAppWhitelistEntryView>
  ) => Promise<void>;
}

/** `WhitelistEntryRow` 单个白名单条目行的属性参数。 */
interface WhitelistEntryRowProps {
  /** 当前行的白名单条目。 */
  readonly entry: Readonly<MiniAppWhitelistEntryView>;
  /** 当前行的权限抽屉是否展开。 */
  readonly isExpanded: boolean;
  /** 当前行是否为已移出白名单后处于抽屉收起保留期的只读快照行。 */
  readonly isClosing: boolean;
  /** 当前是否有增删操作在途。 */
  readonly busyAction: boolean;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换某个条目权限配置抽屉展开/收起的回调。 */
  readonly onTogglePermissionDrawer: (id: number) => void;
  /** 关闭权限配置抽屉的回调。 */
  readonly onClosePermissionDrawer: () => void;
  /** 权限配置更新后的刷新回调。 */
  readonly onPermissionsUpdated: () => Promise<void> | void;
  /** 移除指定白名单条目的回调。 */
  readonly onRemoveWhitelist: (
    entry: Readonly<MiniAppWhitelistEntryView>
  ) => Promise<void>;
}

/**
 * 渲染单个白名单条目行、「配置权限」「移出」按钮组与按需延迟卸载的内联权限抽屉；
 * 抽屉展开时以条目行为跟滚锚点、抽屉为展开内容，按 `resolveExpandFollowScrollTarget` 与展开动画同帧跟滚。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function WhitelistEntryRowView({
  entry,
  isExpanded,
  isClosing,
  busyAction,
  t,
  onTogglePermissionDrawer,
  onClosePermissionDrawer,
  onPermissionsUpdated,
  onRemoveWhitelist,
}: WhitelistEntryRowProps): React.JSX.Element {
  const rowGroupRef: React.RefObject<ViewportRectElement | null> =
    useRef<ViewportRectElement | null>(null);
  const {
    displayValue: mountedDrawerEntry,
  }: Readonly<DelayedUnmountState<Readonly<MiniAppWhitelistEntryView>>> =
    useDelayedUnmount(
      isExpanded ? entry : null,
      MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS
    );
  const setRowGroupNode: (el: ViewportRectElement | null) => void =
    useCallback((el: ViewportRectElement | null): void => {
      rowGroupRef.current = el;
    }, []);
  const resolveDrawerFollowScroll: FlipFollowScrollResolver = useCallback(
    (
      gridElement: FlipAnimatableElement,
      expandedHeightPx: number
    ): ViewportAnchorScrollTarget | null =>
      resolveExpandFollowScrollTarget(
        rowGroupRef.current,
        gridElement,
        expandedHeightPx
      ),
    []
  );
  let enabledCount: number = 0;
  for (const key of WHITELIST_PERMISSION_KEYS) {
    if (entry.permissions[key]) {
      enabledCount += 1;
    }
  }
  const permSubText: string = `ID: ${entry.id} · ${t.identities.enabledPermCountText(
    enabledCount,
    WHITELIST_PERMISSION_KEYS.length
  )}`;
  return (
    <div
      ref={setRowGroupNode}
      className="identity-row-group"
      aria-hidden={isClosing ? true : undefined}
      style={isClosing ? { pointerEvents: "none" } : undefined}
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
            tabIndex={isClosing ? -1 : undefined}
            onClick={(): void => {
              if (isClosing) {
                return;
              }
              onTogglePermissionDrawer(entry.id);
            }}
          >
            {t.identities.configurePermButton}
          </button>
          <button
            type="button"
            className="btn danger icon-btn"
            disabled={busyAction}
            tabIndex={isClosing ? -1 : undefined}
            onClick={(): void => {
              if (isClosing) {
                return;
              }
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
        animateOnInitialExpand
        resolveFollowScroll={resolveDrawerFollowScroll}
      >
        {mountedDrawerEntry !== null ? (
          <MemoizedPermissionDrawer
            entry={mountedDrawerEntry}
            onUpdated={onPermissionsUpdated}
            onClose={onClosePermissionDrawer}
          />
        ) : null}
      </CollapseGrid>
    </div>
  );
}

/** 按属性浅比较跳过重渲染的白名单条目行：切换权限抽屉时只有展开态变化的行重新渲染。 */
const WhitelistEntryRow: React.MemoExoticComponent<
  typeof WhitelistEntryRowView
> = memo(WhitelistEntryRowView);

/** 白名单权限抽屉处于展开态时的行快照（条目从实时列表移出后的保留期按原下标回插渲染）。 */
export interface ExpandedWhitelistRowSnapshot {
  /** 列表分页与筛选上下文键（切换子标签、页码、每页条数或防抖关键字时不跨上下文回插）。 */
  readonly contextKey: string;
  /** 条目在原列表中的下标位置。 */
  readonly index: number;
  /** 展开权限抽屉的白名单条目快照。 */
  readonly entry: Readonly<MiniAppWhitelistEntryView>;
}

/** `useRetainedClosingWhitelistItems` 返回的渲染列表与收起保留行标识。 */
export interface RetainedClosingWhitelistState {
  /** 合并收起过渡保留项后的当前页白名单条目只读数组。 */
  readonly items: readonly Readonly<MiniAppWhitelistEntryView>[];
  /** 处于收起保留期的已移出白名单条目 ID（无保留行时为 `null`）。 */
  readonly closingEntryId: number | null;
}

/**
 * 将延迟卸载保留的白名单展开行快照合并回当前页实时列表：仅当 `contextKey` 与快照一致且实时列表中不再包含该条目时，
 * 按原下标（夹紧至当前列表长度）插回该条目；切换页码、每页条数、子标签或搜索词时直接返回实时列表，不跨上下文回插。
 *
 * @param items 当前页实时白名单条目数组
 * @param retainedSnapshot 延迟卸载保留的展开行快照
 * @param contextKey 当前分页与筛选上下文键
 * @returns 合并收起过渡保留项后的白名单条目只读数组
 */
export function mergeRetainedClosingWhitelistItems(
  items: readonly Readonly<MiniAppWhitelistEntryView>[],
  retainedSnapshot: Readonly<ExpandedWhitelistRowSnapshot> | null,
  contextKey: string
): readonly Readonly<MiniAppWhitelistEntryView>[] {
  if (
    retainedSnapshot?.contextKey !== contextKey ||
    items.some(
      (item: Readonly<MiniAppWhitelistEntryView>): boolean =>
        item.id === retainedSnapshot.entry.id
    )
  ) {
    return items;
  }
  const insertAt: number = Math.min(Math.max(0, retainedSnapshot.index), items.length);
  return [
    ...items.slice(0, insertAt),
    retainedSnapshot.entry,
    ...items.slice(insertAt),
  ];
}

/**
 * 计算合并延迟卸载保留项后的白名单列表与当前收起保留行 ID：
 * 当保留项按同 `contextKey` 回插到实时列表时，将其 ID 标记为 `closingEntryId`；其余情形 `closingEntryId` 为 `null`。
 *
 * @param items 当前页实时白名单条目数组
 * @param retainedSnapshot 延迟卸载保留的展开行快照
 * @param contextKey 当前分页与筛选上下文键
 * @returns 合并后的白名单条目只读数组与收起保留行 ID
 */
export function resolveRetainedClosingWhitelistState(
  items: readonly Readonly<MiniAppWhitelistEntryView>[],
  retainedSnapshot: Readonly<ExpandedWhitelistRowSnapshot> | null,
  contextKey: string
): RetainedClosingWhitelistState {
  const mergedItems: readonly Readonly<MiniAppWhitelistEntryView>[] =
    mergeRetainedClosingWhitelistItems(items, retainedSnapshot, contextKey);
  const closingEntryId: number | null =
    mergedItems !== items && retainedSnapshot !== null
      ? retainedSnapshot.entry.id
      : null;
  return { items: mergedItems, closingEntryId };
}

/**
 * 在已展开权限抽屉的白名单条目被移出且列表静默刷新后，在 `MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS` 时段内按原下标保留该条目快照并返回其 `closingEntryId`，
 * 到期后卸载行节点；切换分页或搜索上下文时立即放弃旧快照。
 *
 * @param items 当前页实时白名单条目数组
 * @param selectedEntryId 当前展开权限抽屉的条目 ID
 * @param contextKey 当前分页与筛选上下文键
 * @returns 合并后的白名单条目只读数组与收起保留行 ID
 */
export function useRetainedClosingWhitelistItems(
  items: readonly Readonly<MiniAppWhitelistEntryView>[],
  selectedEntryId: number | null,
  contextKey: string
): RetainedClosingWhitelistState {
  const activeSnapshot: ExpandedWhitelistRowSnapshot | null = useMemo(
    (): ExpandedWhitelistRowSnapshot | null => {
      if (selectedEntryId === null) {
        return null;
      }
      for (let i: number = 0; i < items.length; i += 1) {
        const candidate: Readonly<MiniAppWhitelistEntryView> | undefined = items[i];
        if (candidate?.id === selectedEntryId) {
          return { contextKey, index: i, entry: candidate };
        }
      }
      return null;
    },
    [items, selectedEntryId, contextKey]
  );
  const {
    displayValue: retainedSnapshot,
  }: Readonly<DelayedUnmountState<ExpandedWhitelistRowSnapshot>> = useDelayedUnmount(
    activeSnapshot,
    MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
    contextKey
  );
  return resolveRetainedClosingWhitelistState(items, retainedSnapshot, contextKey);
}

/**
 * 渲染白名单成员列表行及每行的「配置权限」「移出」按钮组与内联展开抽屉。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function WhitelistEntryRowListView({
  items,
  selectedEntryId,
  closingEntryId = null,
  busyAction,
  t,
  onTogglePermissionDrawer,
  onClosePermissionDrawer,
  onPermissionsUpdated,
  onRemoveWhitelist,
}: WhitelistEntryRowListProps): React.JSX.Element {
  return (
    <Fragment>
      {items.map(
        (entry: Readonly<MiniAppWhitelistEntryView>): React.JSX.Element => (
          <WhitelistEntryRow
            key={entry.id}
            entry={entry}
            isExpanded={selectedEntryId === entry.id}
            isClosing={closingEntryId === entry.id}
            busyAction={busyAction}
            t={t}
            onTogglePermissionDrawer={onTogglePermissionDrawer}
            onClosePermissionDrawer={onClosePermissionDrawer}
            onPermissionsUpdated={onPermissionsUpdated}
            onRemoveWhitelist={onRemoveWhitelist}
          />
        )
      )}
    </Fragment>
  );
}

/** 按属性浅比较跳过重渲染的白名单列表：展开顶部添加抽屉或编辑搜索框时不重复遍历列表。 */
export const WhitelistEntryRowList: React.MemoExoticComponent<
  typeof WhitelistEntryRowListView
> = memo(WhitelistEntryRowListView);

/** `BlocklistEntryRowList` 黑名单条目与操作按钮列表的属性参数。 */
export interface BlocklistEntryRowListProps {
  /** 当前页的黑名单条目数组。 */
  readonly items: readonly Readonly<MiniAppBlocklistEntryView>[];
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
function BlocklistEntryRowListView({
  items,
  busyAction,
  t,
  onRemoveBlocklist,
}: BlocklistEntryRowListProps): React.JSX.Element {
  return (
    <Fragment>
      {items.map(
        (entry: Readonly<MiniAppBlocklistEntryView>): React.JSX.Element => {
          const blockSubText: string = `ID: ${entry.id} · ${t.identities.blockedAtText(entry.blockedAt)}`;
          return (
            <div
              key={entry.id}
              className="row identity-row"
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
    </Fragment>
  );
}

/** 按属性浅比较跳过重渲染的黑名单列表：展开顶部添加抽屉或编辑搜索框时不重复遍历列表。 */
export const BlocklistEntryRowList: React.MemoExoticComponent<
  typeof BlocklistEntryRowListView
> = memo(BlocklistEntryRowListView);
