import { useEffect } from "react";
import type React from "react";
import { CollapseGrid } from "../components/animations/CollapseGrid";
import { IdentitySearchAndAddCard } from "../components/IdentitySearchAndAddCard";
import { PaginationBar } from "../components/PaginationBar";
import { PermissionDrawer } from "../components/PermissionDrawer";
import { ListSkeletonRows } from "../components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../components/skeletons/LoadingBox";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_SEARCH_DEBOUNCE_MS,
} from "../consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../consts/whitelist";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  sanitizeBidiText,
  truncateDisplayText,
} from "../libs/formatters";
import {
  AlertSvgIcon,
  CloseSvgIcon,
  IdentitiesSvgIcon,
  RefreshSvgIcon,
  TrashSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createIdentitiesStore } from "../store/identities";
import type { MiniAppIdentitiesStoreState } from "../store/identities";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppLanguage,
  MiniAppWhitelistEntryView,
} from "../types/miniApp";

/**
 * 黑白名单与权限矩阵管理页面（支持 0.5s 防抖按名称搜索、折叠式三合一添加菜单、重复添加拦截提示与权限抽屉）。
 *
 * @returns React 节点
 */
export function IdentitiesPage(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const storeState: MiniAppIdentitiesStoreState = useComponentStore(createIdentitiesStore);
  const {
    subTab,
    searchInput,
    debouncedQuery,
    duplicateAlertText,
    busyAction,
    loadingList,
    whitelistPageNumber,
    whitelistPageSize,
    whitelistPage,
    selectedEntryId,
    blocklistPageNumber,
    blocklistPageSize,
    blocklistPage,
    whitelistTotal,
    blocklistTotal,
    loadCurrentList,
    selectSubTab,
    commitSearchQuery,
    dismissDuplicateAlert,
    removeWhitelist,
    removeBlocklist,
    togglePermissionDrawer,
    closePermissionDrawer,
    setWhitelistPageNumber,
    setWhitelistPageSize,
    setBlocklistPageNumber,
    setBlocklistPageSize,
  }: MiniAppIdentitiesStoreState = storeState;

  useEffect((): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      commitSearchQuery(searchInput.trim());
    }, MINI_APP_SEARCH_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [commitSearchQuery, searchInput]);

  useEffect((): void => {
    void loadCurrentList();
  }, [
    blocklistPageNumber,
    blocklistPageSize,
    debouncedQuery,
    loadCurrentList,
    subTab,
    whitelistPageNumber,
    whitelistPageSize,
  ]);

  const reloadList = (): void => {
    void loadCurrentList();
  };

  return (
    <section className="animate-fade-in">
      <div className="subtabs-bar">
        <div className="subtabs-group">
          <button
            type="button"
            className={`subtab-btn ${subTab === "whitelist" ? "active" : ""}`}
            onClick={(): void => {
              selectSubTab("whitelist");
            }}
          >
            <IdentitiesSvgIcon size={14} />
            <span>{t.identities.whitelistTab}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn danger-tab ${subTab === "blocklist" ? "active" : ""}`}
            onClick={(): void => {
              selectSubTab("blocklist");
            }}
          >
            <span>{t.identities.blocklistTab}</span>
          </button>
        </div>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loadingList}
          onClick={reloadList}
        >
          <RefreshSvgIcon size={14} className={loadingList ? "spin-icon" : ""} />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {duplicateAlertText !== null
        ? (
          <div className="duplicate-alert-banner animate-fade-in" role="alert">
            <div className="duplicate-alert-content">
              <AlertSvgIcon size={18} />
              <div>
                <div className="duplicate-alert-title">
                  {t.identities.duplicateBannerTitle}
                </div>
                <div className="duplicate-alert-desc">{duplicateAlertText}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn icon-btn"
              onClick={dismissDuplicateAlert}
            >
              <CloseSvgIcon size={14} />
            </button>
          </div>
        )
        : null}

      <IdentitySearchAndAddCard state={storeState} />

      {subTab === "whitelist"
        ? (
          <div className="card">
            {loadingList && whitelistPage === null
              ? (
                <LoadingBox text={t.identities.loadingText}>
                  <ListSkeletonRows count={MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE} />
                </LoadingBox>
              )
              : null}

            {whitelistPage !== null && whitelistPage.items.length === 0
              ? (
                <div className="empty">
                  {debouncedQuery.length > 0
                    ? t.identities.emptySearchHint(debouncedQuery)
                    : t.identities.emptyListHint("whitelist")}
                </div>
              )
              : null}

            {whitelistPage?.items.map((entry: Readonly<MiniAppWhitelistEntryView>): React.JSX.Element => {
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
                        {entry.username !== undefined
                          ? (
                            <span
                              className="identity-username"
                              dir="ltr"
                              title={`@${sanitizeBidiText(entry.username)}`}
                            >
                              @{truncateDisplayText(entry.username, 9)}
                            </span>
                          )
                          : null}
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
                          togglePermissionDrawer(entry.id);
                        }}
                      >
                        {t.identities.configurePermButton}
                      </button>
                      <button
                        type="button"
                        className="btn danger icon-btn"
                        disabled={busyAction}
                        onClick={(): void => {
                          void removeWhitelist(entry);
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
                      descriptors={whitelistPage.permissionDescriptors}
                      onUpdated={reloadList}
                      onClose={closePermissionDrawer}
                    />
                  </CollapseGrid>
                </div>
              );
            })}

            <PaginationBar
              page={whitelistPage?.page ?? whitelistPageNumber}
              totalPages={whitelistPage?.totalPages ?? 1}
              total={whitelistPage?.total ?? whitelistTotal}
              pageSize={whitelistPage?.pageSize ?? whitelistPageSize}
              pageSizeOptions={MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS}
              disabled={loadingList || busyAction}
              onPageChange={setWhitelistPageNumber}
              onPageSizeChange={setWhitelistPageSize}
            />
          </div>
        )
        : (
          <div className="card">
            {loadingList && blocklistPage === null
              ? (
                <LoadingBox text={t.identities.loadingText}>
                  <ListSkeletonRows count={MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE} />
                </LoadingBox>
              )
              : null}

            {blocklistPage !== null && blocklistPage.items.length === 0
              ? (
                <div className="empty">
                  {debouncedQuery.length > 0
                    ? t.identities.emptySearchHint(debouncedQuery)
                    : t.identities.emptyListHint("blocklist")}
                </div>
              )
              : null}

            {blocklistPage?.items.map((entry: Readonly<MiniAppBlocklistEntryView>): React.JSX.Element => {
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
                      {entry.username !== undefined
                        ? (
                          <span
                            className="identity-username"
                            dir="ltr"
                            title={`@${sanitizeBidiText(entry.username)}`}
                          >
                            @{truncateDisplayText(entry.username, 11)}
                          </span>
                        )
                        : null}
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
                        void removeBlocklist(entry);
                      }}
                    >
                      <TrashSvgIcon size={14} />
                      <span>{t.identities.removeBlocklistButton}</span>
                    </button>
                  </div>
                </div>
              );
            })}

            <PaginationBar
              page={blocklistPage?.page ?? blocklistPageNumber}
              totalPages={blocklistPage?.totalPages ?? 1}
              total={blocklistPage?.total ?? blocklistTotal}
              pageSize={blocklistPage?.pageSize ?? blocklistPageSize}
              pageSizeOptions={MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS}
              disabled={loadingList || busyAction}
              onPageChange={setBlocklistPageNumber}
              onPageSizeChange={setBlocklistPageSize}
            />
          </div>
        )}
    </section>
  );
}
