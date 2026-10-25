import { useState } from "react";
import type React from "react";
import { WHITELIST_PERMISSION_KEYS } from "../../../consts/whitelist";
import type { WhitelistPermissionKey } from "../../../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppLanguage,
  MiniAppPermissionDescriptor,
  MiniAppWhitelistEntryView,
} from "../../../types/miniApp";
import { CloseSvgIcon } from "../../miniAppResoures";
import { updateMiniAppWhitelistPermission } from "../api";
import {
  getPermissionDisplayLabel,
  sanitizeBidiText,
  truncateDisplayText,
} from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";

/** `PermissionDrawer` 组件的属性参数。 */
export interface PermissionDrawerProps {
  /** 当前正在编辑权限的白名单条目。 */
  readonly entry: MiniAppWhitelistEntryView;
  /** 后端返回的权限键说明列表。 */
  readonly descriptors: readonly Readonly<MiniAppPermissionDescriptor>[];
  /** 权限变更成功后触发父组件重新加载白名单。 */
  readonly onUpdated: () => void;
  /** 关闭权限编辑抽屉。 */
  readonly onClose: () => void;
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * 白名单条目细粒度权限开关控制面板组件（支持单项切换与一键开启全部 18 项权限）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function PermissionDrawer({
  entry,
  descriptors,
  onUpdated,
  onClose,
  onToast,
}: PermissionDrawerProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const [busyKey, setBusyKey]: [
    WhitelistPermissionKey | "all" | null,
    React.Dispatch<React.SetStateAction<WhitelistPermissionKey | "all" | null>>
  ] = useState<WhitelistPermissionKey | "all" | null>(null);

  const handleTogglePermission = async (
    permission: WhitelistPermissionKey | "all",
    enabled: boolean
  ): Promise<void> => {
    setBusyKey(permission);
    try {
      const result: MiniAppIdentityMutationResult = await updateMiniAppWhitelistPermission(
        entry.id,
        permission,
        enabled
      );
      onToast(result.message);
      onUpdated();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="perm-drawer-inline animate-fade-in">
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
            disabled={busyKey !== null}
            onClick={(): void => {
              void handleTogglePermission("all", true);
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
          const descriptor: Readonly<MiniAppPermissionDescriptor> | undefined =
            descriptors.find(
              (item: Readonly<MiniAppPermissionDescriptor>): boolean => item.key === key
            );
          const permLabel: string = getPermissionDisplayLabel(key, language);
          return (
            <div key={key} className="perm-chip" title={descriptor?.description ?? permLabel}>
              <span className="perm-chip-label">{permLabel}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busyKey !== null}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    const nextChecked: boolean = (
                      event.currentTarget as unknown as { readonly checked: boolean }
                    ).checked;
                    void handleTogglePermission(key, nextChecked);
                  }}
                />
                <span className="slider" />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
