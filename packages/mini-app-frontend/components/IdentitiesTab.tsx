import { useEffect } from "react";
import type React from "react";
import {
  MINI_APP_IDENTITY_ADD_MODES,
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
  ChannelSvgIcon,
  ChevronDownSvgIcon,
  CloseSvgIcon,
  HashtagSvgIcon,
  IdentitiesSvgIcon,
  PlusSvgIcon,
  RefreshSvgIcon,
  SearchSvgIcon,
  TrashSvgIcon,
  UserSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createIdentitiesStore } from "../store/identities";
import type { MiniAppIdentitiesStoreState } from "../store/identities";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppIdentityAddMode,
  MiniAppLanguage,
  MiniAppWhitelistEntryView,
} from "../types/miniApp";
import { PaginationBar } from "./PaginationBar";
import { PermissionDrawer } from "./PermissionDrawer";
import { ListSkeletonRows } from "./skeletons/ListSkeletonRows";
import { LoadingBox } from "./skeletons/LoadingBox";

/**
 * 根据添加模式键渲染对应的 SVG 图标。
 *
 * @param mode 添加模式键
 * @returns SVG 图标元素
 */
function renderAddModeIcon(mode: MiniAppIdentityAddMode): React.JSX.Element {
  if (mode === "id") return <HashtagSvgIcon size={15} />;
  if (mode === "users") return <UserSvgIcon size={15} />;
  return <ChannelSvgIcon size={15} />;
}

/**
 * 黑白名单与权限矩阵管理组件（支持 0.5s 防抖按名称搜索、折叠式三合一添加菜单、重复添加拦截提示与权限抽屉）。
 *
 * @returns React 节点
 */
export function IdentitiesTab(): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    subTab,
    searchInput,
    debouncedQuery,
    addMenuOpen,
    idFormOpen,
    idInput,
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
    setSearchInput,
    commitSearchQuery,
    clearSearch,
    toggleAddMenu,
    selectAddMode,
    closeIdForm,
    setIdInput,
    dismissDuplicateAlert,
    addById,
    removeWhitelist,
    removeBlocklist,
    togglePermissionDrawer,
    closePermissionDrawer,
    setWhitelistPageNumber,
    setWhitelistPageSize,
    setBlocklistPageNumber,
    setBlocklistPageSize,
  }: MiniAppIdentitiesStoreState = useComponentStore(createIdentitiesStore);

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

  const isDebouncing: boolean = searchInput.trim() !== debouncedQuery;

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

      <div className="card">
        <div className="search-and-add-bar">
          <div className="search-input-wrap">
            <SearchSvgIcon size={16} className="search-input-icon" />
            <input
              type="search"
              className="search-input"
              value={searchInput}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                const nextValue: string = (
                  event.currentTarget as unknown as { readonly value: string }
                ).value;
                setSearchInput(nextValue);
              }}
              placeholder={t.identities.searchPlaceholder}
            />
            {searchInput.length > 0
              ? (
                <button
                  type="button"
                  className="search-clear-btn"
                  aria-label={t.identities.searchClearAria}
                  onClick={clearSearch}
                >
                  <CloseSvgIcon size={13} />
                </button>
              )
              : null}
          </div>

          <button
            type="button"
            className={`btn primary icon-btn add-fold-trigger ${addMenuOpen ? "open" : ""}`}
            disabled={busyAction}
            onClick={toggleAddMenu}
          >
            <PlusSvgIcon size={16} />
            <span>{t.identities.addFoldButton}</span>
            <ChevronDownSvgIcon
              size={15}
              className={`chevron-icon ${addMenuOpen ? "rotated" : ""}`}
            />
          </button>
        </div>

        {isDebouncing
          ? (
            <div className="debounce-status-hint">
              {t.identities.searchDebounceHint}
            </div>
          )
          : null}

        {addMenuOpen
          ? (
            <div className="add-fold-panel animate-fade-in">
              <div className="add-mode-grid">
                {MINI_APP_IDENTITY_ADD_MODES.map(
                  (mode: MiniAppIdentityAddMode): React.JSX.Element => (
                    <button
                      key={mode}
                      type="button"
                      className={`add-mode-card ${mode === "id" && idFormOpen ? "active" : ""}`}
                      disabled={busyAction}
                      onClick={(): void => {
                        selectAddMode(mode);
                      }}
                    >
                      <div className="add-mode-head">
                        {renderAddModeIcon(mode)}
                        <span>{t.identities.addModes[mode]}</span>
                      </div>
                      <div className="add-mode-desc">
                        {t.identities.addModeDescriptions[mode]}
                      </div>
                    </button>
                  )
                )}
              </div>

              {idFormOpen
                ? (
                  <div className="id-add-inline-row animate-fade-in">
                    <input
                      type="text"
                      value={idInput}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                        const nextValue: string = (
                          event.currentTarget as unknown as { readonly value: string }
                        ).value;
                        setIdInput(nextValue);
                      }}
                      placeholder={t.identities.idInputPlaceholder}
                    />
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busyAction}
                      onClick={(): void => {
                        void addById();
                      }}
                    >
                      {t.identities.idConfirmButton}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={closeIdForm}
                    >
                      {t.identities.idCancelButton}
                    </button>
                  </div>
                )
                : null}
            </div>
          )
          : null}
      </div>

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
                        <TrashSvgIcon size={13} />
                        <span>{t.identities.removeWhitelistButton}</span>
                      </button>
                    </div>
                  </div>
                  {isExpanded
                    ? (
                      <PermissionDrawer
                        entry={entry}
                        descriptors={whitelistPage.permissionDescriptors}
                        onUpdated={reloadList}
                        onClose={closePermissionDrawer}
                      />
                    )
                    : null}
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
                      <TrashSvgIcon size={13} />
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
