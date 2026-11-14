import { useCallback, useEffect } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { InlineNoticeCollapse } from "../components/animations/CollapseGrid";
import {
  BlocklistEntryRowList,
  useRetainedClosingWhitelistItems,
  WhitelistEntryRowList,
} from "../components/IdentityListRows";
import type { RetainedClosingWhitelistState } from "../components/IdentityListRows";
import { IdentitySearchAndAddCard } from "../components/IdentitySearchAndAddCard";
import { IdentitySubtabsBar } from "../components/IdentitySubtabsBar";
import { PaginationBar } from "../components/PaginationBar";
import { ListSkeletonRows } from "../components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../components/skeletons/LoadingBox";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useComponentStoreApi } from "../libs/componentStore";
import {
  AlertSvgIcon,
  CloseSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import { createIdentitiesStore } from "../store/identities";
import type {
  MiniAppIdentitiesStore,
  MiniAppIdentitiesStoreState,
} from "../store/identities";
import type { MiniAppLanguage } from "../types/miniApp";

/** `IdentitiesPage` 列表与分页视图订阅的状态与动作切片（隔离搜索输入与折叠表单草稿重渲染）。 */
type IdentitiesPageViewSlice = Pick<
  MiniAppIdentitiesStoreState,
  | "subTab"
  | "debouncedQuery"
  | "duplicateAlertText"
  | "busyAction"
  | "loadingList"
  | "whitelistPageNumber"
  | "whitelistPageSize"
  | "whitelistPage"
  | "selectedEntryId"
  | "blocklistPageNumber"
  | "blocklistPageSize"
  | "blocklistPage"
  | "whitelistTotal"
  | "blocklistTotal"
  | "loadCurrentList"
  | "selectSubTab"
  | "dismissDuplicateAlert"
  | "removeWhitelist"
  | "removeBlocklist"
  | "togglePermissionDrawer"
  | "closePermissionDrawer"
  | "setWhitelistPageNumber"
  | "setWhitelistPageSize"
  | "setBlocklistPageNumber"
  | "setBlocklistPageSize"
>;

/**
 * 从黑白名单仓库提取 `IdentitiesPage` 主列表与分页视图所需的切片（不含 `searchInput` 与添加抽屉草稿）。
 *
 * @param state 黑白名单完整状态快照
 * @returns 主列表与分页切片
 */
function selectIdentitiesPageViewState(
  state: MiniAppIdentitiesStoreState
): IdentitiesPageViewSlice {
  return {
    subTab: state.subTab,
    debouncedQuery: state.debouncedQuery,
    duplicateAlertText: state.duplicateAlertText,
    busyAction: state.busyAction,
    loadingList: state.loadingList,
    whitelistPageNumber: state.whitelistPageNumber,
    whitelistPageSize: state.whitelistPageSize,
    whitelistPage: state.whitelistPage,
    selectedEntryId: state.selectedEntryId,
    blocklistPageNumber: state.blocklistPageNumber,
    blocklistPageSize: state.blocklistPageSize,
    blocklistPage: state.blocklistPage,
    whitelistTotal: state.whitelistTotal,
    blocklistTotal: state.blocklistTotal,
    loadCurrentList: state.loadCurrentList,
    selectSubTab: state.selectSubTab,
    dismissDuplicateAlert: state.dismissDuplicateAlert,
    removeWhitelist: state.removeWhitelist,
    removeBlocklist: state.removeBlocklist,
    togglePermissionDrawer: state.togglePermissionDrawer,
    closePermissionDrawer: state.closePermissionDrawer,
    setWhitelistPageNumber: state.setWhitelistPageNumber,
    setWhitelistPageSize: state.setWhitelistPageSize,
    setBlocklistPageNumber: state.setBlocklistPageNumber,
    setBlocklistPageSize: state.setBlocklistPageSize,
  };
}

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
  const store: MiniAppIdentitiesStore = useComponentStoreApi(createIdentitiesStore);
  const {
    subTab,
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
    dismissDuplicateAlert,
    removeWhitelist,
    removeBlocklist,
    togglePermissionDrawer,
    closePermissionDrawer,
    setWhitelistPageNumber,
    setWhitelistPageSize,
    setBlocklistPageNumber,
    setBlocklistPageSize,
  }: IdentitiesPageViewSlice = useStore(
    store,
    useShallow(selectIdentitiesPageViewState)
  );

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

  const reloadListSilently: () => Promise<void> = useCallback(
    (): Promise<void> => loadCurrentList(true),
    [loadCurrentList]
  );

  const whitelistContextKey: string = `${subTab}:${whitelistPage?.page ?? whitelistPageNumber}:${whitelistPage?.pageSize ?? whitelistPageSize}:${debouncedQuery}`;
  const {
    items: renderedWhitelistItems,
    closingEntryId,
  }: RetainedClosingWhitelistState = useRetainedClosingWhitelistItems(
    whitelistPage?.items ?? [],
    subTab === "whitelist" ? selectedEntryId : null,
    whitelistContextKey
  );

  return (
    <section className="animate-fade-in">
      <IdentitySubtabsBar
        subTab={subTab}
        loadingList={loadingList}
        t={t}
        onSelectSubTab={selectSubTab}
        onRefresh={reloadList}
      />

      <InlineNoticeCollapse activeValue={duplicateAlertText}>
        {(alertText: string): React.JSX.Element => (
          <div className="duplicate-alert-banner" role="alert">
            <div className="duplicate-alert-content">
              <AlertSvgIcon size={18} />
              <div>
                <div className="duplicate-alert-title">
                  {t.identities.duplicateBannerTitle}
                </div>
                <div className="duplicate-alert-desc">{alertText}</div>
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
        )}
      </InlineNoticeCollapse>

      <IdentitySearchAndAddCard store={store} />

      {subTab === "whitelist"
        ? (
          <div className="card identity-list-card">
            {loadingList
              ? (
                <LoadingBox>
                  <ListSkeletonRows count={MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE} />
                </LoadingBox>
              )
              : null}

            {!loadingList && whitelistPage !== null && renderedWhitelistItems.length === 0
              ? (
                <div className="empty">
                  {debouncedQuery.length > 0
                    ? t.identities.emptySearchHint(debouncedQuery)
                    : t.identities.emptyListHint("whitelist")}
                </div>
              )
              : null}

            {!loadingList && whitelistPage !== null && renderedWhitelistItems.length > 0 ? (
              <WhitelistEntryRowList
                items={renderedWhitelistItems}
                selectedEntryId={selectedEntryId}
                closingEntryId={closingEntryId}
                busyAction={busyAction}
                t={t}
                onTogglePermissionDrawer={togglePermissionDrawer}
                onClosePermissionDrawer={closePermissionDrawer}
                onPermissionsUpdated={reloadListSilently}
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
            {loadingList
              ? (
                <LoadingBox>
                  <ListSkeletonRows count={MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE} />
                </LoadingBox>
              )
              : null}

            {!loadingList && blocklistPage !== null && blocklistPage.items.length === 0
              ? (
                <div className="empty">
                  {debouncedQuery.length > 0
                    ? t.identities.emptySearchHint(debouncedQuery)
                    : t.identities.emptyListHint("blocklist")}
                </div>
              )
              : null}

            {!loadingList && blocklistPage !== null && blocklistPage.items.length > 0 ? (
              <BlocklistEntryRowList
                items={blocklistPage.items}
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
