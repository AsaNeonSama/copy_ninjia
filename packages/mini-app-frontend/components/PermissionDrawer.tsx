import { Fragment, memo } from "react";
import type React from "react";
import { WHITELIST_PERMISSION_KEYS } from "../consts/whitelist";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  getPermissionDisplayLabel,
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import { CloseSvgIcon } from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createPermissionDrawerStore } from "../store/permissionDrawer";
import type {
  MiniAppPermissionDrawerStore,
  MiniAppPermissionDrawerStoreState,
} from "../store/permissionDrawer";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppLanguage,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
} from "../types/miniApp";

/** `PermissionDrawer` 组件的属性参数。 */
export interface PermissionDrawerProps {
  /** 当前正在编辑权限的白名单条目。 */
  readonly entry: MiniAppWhitelistEntryView;
  /** 后端返回的权限键说明列表。 */
  readonly descriptors: readonly Readonly<MiniAppPermissionDescriptor>[];
  /** 权限变更成功后触发父组件静默重新加载白名单；抽屉创建仓库时捕获首次渲染传入的回调，之后的重渲染不再替换。 */
  readonly onUpdated: () => Promise<void> | void;
  /** 关闭权限编辑抽屉。 */
  readonly onClose: () => void;
  /** 可选的状态仓库工厂（默认按 `onUpdated` 创建 `createPermissionDrawerStore`）。 */
  readonly storeFactory?: () => MiniAppPermissionDrawerStore;
}

/** `PermissionChip` 单项权限卡片的属性参数。 */
interface PermissionChipProps {
  /** 目标白名单条目 ID。 */
  readonly entryId: number;
  /** 权限键。 */
  readonly permKey: WhitelistPermissionKey;
  /** 当前权限是否已开启。 */
  readonly checked: boolean;
  /** 当前权限卡片是否处于请求骨架态。 */
  readonly isChipLoading: boolean;
  /** 当前抽屉是否有任意权限操作在途（禁用开关交互）。 */
  readonly switchDisabled: boolean;
  /** 本地化权限展示名称。 */
  readonly permLabel: string;
  /** 悬停提示文本。 */
  readonly titleText: string;
  /** 触发权限切换的回调。 */
  readonly onTogglePermission: (
    id: number,
    key: WhitelistPermissionKey | "all",
    enabled: boolean
  ) => Promise<void>;
}

/**
 * 渲染单项白名单权限开关卡片（请求中展示双行骨架占位，空闲时展示标签与滑块开关）。
 *
 * @param props 单项权限卡片属性
 * @returns React 节点
 */
function PermissionChipView({
  entryId,
  permKey,
  checked,
  isChipLoading,
  switchDisabled,
  permLabel,
  titleText,
  onTogglePermission,
}: PermissionChipProps): React.JSX.Element {
  return (
    <div
      className={`perm-chip ${isChipLoading ? "is-loading" : ""}`}
      aria-busy={isChipLoading}
      title={titleText}
    >
      {isChipLoading ? (
        <Fragment>
          <div className="skeleton-line perm-chip-skeleton-label" />
          <div className="skeleton-line perm-chip-skeleton-switch" />
        </Fragment>
      ) : (
        <Fragment>
          <span className="perm-chip-label">{permLabel}</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={checked}
              disabled={switchDisabled}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                const nextChecked: boolean = (
                  event.currentTarget as unknown as { readonly checked: boolean }
                ).checked;
                void onTogglePermission(entryId, permKey, nextChecked);
              }}
            />
            <span className="slider" />
          </label>
        </Fragment>
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的单项权限卡片组件。 */
const PermissionChip: React.MemoExoticComponent<typeof PermissionChipView> =
  memo(PermissionChipView);

/**
 * 白名单条目细粒度权限开关控制面板组件（支持单项切换与一键开启全部 18 项权限；
 * 切换单项时仅对应卡片播放骨架效果，点击一键全开时全部 18 项卡片播放骨架效果，已全开时提示无需重复开启）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function PermissionDrawer({
  entry,
  descriptors,
  onUpdated,
  onClose,
  storeFactory,
}: PermissionDrawerProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const { busyKey, togglePermission }: MiniAppPermissionDrawerStoreState = useComponentStore(
    storeFactory ?? ((): MiniAppPermissionDrawerStore => createPermissionDrawerStore(onUpdated))
  );
  const allPermissionsEnabled: boolean = WHITELIST_PERMISSION_KEYS.every(
    (key: WhitelistPermissionKey): boolean => entry.permissions[key]
  );
  const switchDisabled: boolean = busyKey !== null;

  return (
    <div className="perm-drawer-inline">
      <div className="card-title perm-drawer-head">
        <div className="perm-drawer-title-wrap">
          <div className="identity-title-row">
            <bdi
              className="identity-name"
              title={sanitizeBidiText(entry.displayName)}
            >
              {t.permissionDrawer.title(
                truncateDisplayText(entry.displayName, 12)
              )}
            </bdi>
            <span
              className={`badge ${
                entry.isChannel ? "identity-channel-badge" : "identity-user-badge"
              }`}
            >
              {entry.isChannel
                ? t.identities.channelBadge
                : t.identities.userBadge}
            </span>
          </div>
          <div className="row-sub identity-sub-row">
            {t.permissionDrawer.subtitle(entry.id, entry.isChannel)}
          </div>
        </div>
        <div className="toolbar-actions identity-row-actions">
          <button
            type="button"
            className="btn primary"
            disabled={switchDisabled}
            aria-busy={busyKey === "all"}
            onClick={(): void => {
              if (allPermissionsEnabled) {
                useMiniAppStore.getState().notify(
                  "ALL_PERMISSIONS_UNCHANGED",
                  "warning",
                  { id: entry.id }
                );
                return;
              }
              void togglePermission(entry.id, "all", true);
            }}
          >
            {t.permissionDrawer.enableAllButton}
          </button>
          <button type="button" className="btn icon-btn" onClick={onClose}>
            <CloseSvgIcon size={14} />
            <span>{t.permissionDrawer.closeButton}</span>
          </button>
        </div>
      </div>

      <div className="perm-grid">
        {WHITELIST_PERMISSION_KEYS.map((key: WhitelistPermissionKey): React.JSX.Element => {
          const checked: boolean = entry.permissions[key];
          const isChipLoading: boolean = busyKey === "all" || busyKey === key;
          const descriptor: Readonly<MiniAppPermissionDescriptor> | undefined =
            descriptors.find(
              (item: Readonly<MiniAppPermissionDescriptor>): boolean => item.key === key
            );
          const permLabel: string = getPermissionDisplayLabel(key, language);
          return (
            <PermissionChip
              key={key}
              entryId={entry.id}
              permKey={key}
              checked={checked}
              isChipLoading={isChipLoading}
              switchDisabled={switchDisabled}
              permLabel={permLabel}
              titleText={descriptor?.description ?? permLabel}
              onTogglePermission={togglePermission}
            />
          );
        })}
      </div>
    </div>
  );
}
