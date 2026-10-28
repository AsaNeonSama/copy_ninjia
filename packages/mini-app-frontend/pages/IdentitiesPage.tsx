import { useCallback, useEffect } from "react";
import type React from "react";
import {
  BlocklistEntryRowList,
  WhitelistEntryRowList,
} from "../components/IdentityListRows";
import { IdentitySearchAndAddCard } from "../components/IdentitySearchAndAddCard";
import { IdentitySubtabsBar } from "../components/IdentitySubtabsBar";
import { PaginationBar } from "../components/PaginationBar";
import { ListSkeletonRows } from "../components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../components/skeletons/LoadingBox";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_SEARCH_DEBOUNCE_MS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStore } from "../libs/componentStore";
import {
  AlertSvgIcon,
  CloseSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createIdentitiesStore } from "../store/identities";
import type { MiniAppIdentitiesStoreState } from "../store/identities";
import type { MiniAppLanguage } from "../types/miniApp";

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

  const reloadList: () => void = useCallback((): void => {
    void loadCurrentList();
  }, [loadCurrentList]);

  return (
    <section className="animate-fade-in">
      <IdentitySubtabsBar
        subTab={subTab}
        loadingList={loadingList}
        t={t}
        onSelectSubTab={selectSubTab}
        onRefresh={reloadList}
      />

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
          <div className="card identity-list-card">
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

            {whitelistPage !== null ? (
              <WhitelistEntryRowList
                items={whitelistPage.items}
                permissionDescriptors={whitelistPage.permissionDescriptors}
                selectedEntryId={selectedEntryId}
                loadingList={loadingList}
                busyAction={busyAction}
                t={t}
                onTogglePermissionDrawer={togglePermissionDrawer}
                onClosePermissionDrawer={closePermissionDrawer}
                onPermissionsUpdated={reloadList}
                onRemoveWhitelist={removeWhitelist}
              />
            ) : null}

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
          <div className="card identity-list-card">
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

            {blocklistPage !== null ? (
              <BlocklistEntryRowList
                items={blocklistPage.items}
                loadingList={loadingList}
                busyAction={busyAction}
                t={t}
                onRemoveBlocklist={removeBlocklist}
              />
            ) : null}

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
