import { Fragment, memo, useCallback, useEffect, useState } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AdBlacklistPreviewModal } from "../components/AdBlacklistPreviewModal";
import {
  CollapseGrid,
  InlineNoticeCollapse,
} from "../components/animations/CollapseGrid";
import { useClosingSnapshot } from "../components/animations/useDelayedUnmount";
import { PaginationBar } from "../components/PaginationBar";
import { ListSkeletonRows } from "../components/skeletons/ListSkeletonRows";
import { LoadingBox } from "../components/skeletons/LoadingBox";
import {
  MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE,
  MINI_APP_AD_BLACKLIST_KINDS,
  MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS,
  MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH,
  MINI_APP_SEARCH_DEBOUNCE_MS,
} from "../consts/miniApp/ui";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { buildAdBlacklistPackUrl } from "../libs/adBlacklistPackInput";
import { useComponentStoreApi } from "../libs/componentStore";
import { readEventTargetValue } from "../libs/formatters";
import {
  AlertSvgIcon,
  ChevronDownSvgIcon,
  CloseSvgIcon,
  EyeSvgIcon,
  PlusSvgIcon,
  RefreshSvgIcon,
  SearchSvgIcon,
  TrashSvgIcon,
} from "../resource";
import {
  createAdBlacklistsStore,
} from "../store/adBlacklists";
import type {
  MiniAppAdBlacklistNoticeBanner,
  MiniAppAdBlacklistsStore,
  MiniAppAdBlacklistsStoreState,
} from "../store/adBlacklists";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type {
  MiniAppAdBlacklistItem,
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistsResponse,
} from "../types/miniApp/adBlacklists";
import type { MiniAppLanguage } from "../types/miniApp/ui";

/** `AdBlacklistsPage` 组件属性参数。 */
export interface AdBlacklistsPageProps {
  /** 可选的状态仓库工厂（默认 `createAdBlacklistsStore`）。 */
  readonly storeFactory?: () => MiniAppAdBlacklistsStore;
}

export { buildAdBlacklistPackUrl };

/** 顶部搜索与折叠添加控制卡片属性参数。 */
interface AdBlacklistsControlsCardProps {
  /** 内容黑名单管理状态仓库实例；卡片按输入与展开态切片自订阅。 */
  readonly store: MiniAppAdBlacklistsStore;
}

/** 顶部搜索与折叠添加控制卡片订阅的状态与动作切片（隔离每次按键输入及展开/收起引发的列表重渲染）。 */
type AdBlacklistsControlsCardSlice = Pick<
  MiniAppAdBlacklistsStoreState,
  | "searchInput"
  | "addFormOpen"
  | "addPackInput"
  | "busyAction"
  | "setSearchInput"
  | "commitSearchQuery"
  | "clearSearch"
  | "toggleAddForm"
  | "setAddPackInput"
  | "addPack"
>;

/**
 * 从内容黑名单仓库提取顶部搜索与折叠添加切片。
 *
 * @param state 内容黑名单仓库完整状态快照
 * @returns 顶部控制卡片切片
 */
function selectAdBlacklistsControlsCardSlice(
  state: MiniAppAdBlacklistsStoreState
): AdBlacklistsControlsCardSlice {
  return {
    searchInput: state.searchInput,
    addFormOpen: state.addFormOpen,
    addPackInput: state.addPackInput,
    busyAction: state.busyAction,
    setSearchInput: state.setSearchInput,
    commitSearchQuery: state.commitSearchQuery,
    clearSearch: state.clearSearch,
    toggleAddForm: state.toggleAddForm,
    setAddPackInput: state.setAddPackInput,
    addPack: state.addPack,
  };
}

/**
 * 按切片自订阅渲染内容黑名单页的防抖搜索框与默认收起的折叠添加包名表单，避免输入按键及面板开合触发列表行与分页重渲染。
 *
 * @param props 仓库引用属性
 * @returns React 节点
 */
function AdBlacklistsControlsCardView({
  store,
}: AdBlacklistsControlsCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    searchInput,
    addFormOpen,
    addPackInput,
    busyAction,
    setSearchInput,
    commitSearchQuery,
    clearSearch,
    toggleAddForm,
    setAddPackInput,
    addPack,
  }: AdBlacklistsControlsCardSlice = useStore(
    store,
    useShallow(selectAdBlacklistsControlsCardSlice)
  );
  const [isComposing, setIsComposing]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);

  useEffect((): (() => void) | undefined => {
    if (isComposing) {
      return undefined;
    }
    const trimmed: string = searchInput.trim();
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      commitSearchQuery(trimmed);
    }, MINI_APP_SEARCH_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [commitSearchQuery, isComposing, searchInput]);

  const handleAddSubmit: (event: React.SyntheticEvent<HTMLFormElement>) => void =
    useCallback(
      (event: React.SyntheticEvent<HTMLFormElement>): void => {
        event.preventDefault();
        void addPack();
      },
      [addPack]
    );

  const displayAddPackInput: string = useClosingSnapshot(
    addPackInput,
    addFormOpen
  );
  const displayBusyAction: boolean = useClosingSnapshot(
    busyAction,
    addFormOpen
  );

  return (
    <div className="card">
      <div className="search-and-add-bar">
        <div className="search-input-wrap">
          <SearchSvgIcon size={16} className="search-input-icon" />
          <input
            type="text"
            inputMode="text"
            lang=""
            maxLength={MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH}
            className="search-input"
            value={searchInput}
            onCompositionStart={(): void => {
              setIsComposing(true);
            }}
            onCompositionEnd={(
              event: React.CompositionEvent<HTMLInputElement>
            ): void => {
              setIsComposing(false);
              setSearchInput(readEventTargetValue(event));
            }}
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
              setSearchInput(readEventTargetValue(event));
            }}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>): void => {
              if (event.key === "Enter" && !isComposing) {
                event.preventDefault();
                commitSearchQuery(searchInput.trim());
              }
            }}
            placeholder={t.adBlacklists.searchPlaceholder}
          />
          {searchInput.length > 0
            ? (
              <button
                type="button"
                className="search-clear-btn"
                aria-label={t.adBlacklists.searchClearAria}
                onMouseDown={(
                  event: React.MouseEvent<HTMLButtonElement>
                ): void => {
                  event.preventDefault();
                }}
                onClick={(): void => {
                  setIsComposing(false);
                  clearSearch();
                }}
              >
                <CloseSvgIcon size={14} />
              </button>
            )
            : null}
        </div>

        <button
          type="button"
          className={`btn primary icon-btn add-fold-trigger ${addFormOpen ? "open" : ""}`}
          disabled={busyAction}
          aria-expanded={addFormOpen}
          onClick={toggleAddForm}
        >
          <PlusSvgIcon size={16} />
          <span>{t.adBlacklists.addFoldButton}</span>
          <ChevronDownSvgIcon
            size={14}
            className={`chevron-icon ${addFormOpen ? "rotated" : ""}`}
          />
        </button>
      </div>

      <CollapseGrid
        expanded={addFormOpen}
        gridClassName="add-fold-collapse-grid"
        innerClassName="add-fold-collapse-inner"
      >
        <div className="add-fold-panel">
          <form className="ad-blacklist-add-row" onSubmit={handleAddSubmit}>
            <input
              type="text"
              className="ad-blacklist-add-input"
              value={displayAddPackInput}
              disabled={displayBusyAction}
              tabIndex={addFormOpen ? 0 : -1}
              onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                setAddPackInput(readEventTargetValue(event));
              }}
              placeholder={t.adBlacklists.addInputPlaceholder}
            />
            <button
              type="submit"
              className="btn primary icon-btn ad-blacklist-add-btn"
              disabled={displayBusyAction}
              tabIndex={addFormOpen ? 0 : -1}
            >
              <PlusSvgIcon size={14} />
              <span>
                {displayBusyAction
                  ? t.adBlacklists.addingButton
                  : t.adBlacklists.addButton}
              </span>
            </button>
          </form>
        </div>
      </CollapseGrid>
    </div>
  );
}

/** 仓库引用不变时跳过父级重渲染的顶部搜索与折叠添加控制卡片（内部按输入与展开态切片自订阅）。 */
const AdBlacklistsControlsCard: React.MemoExoticComponent<
  typeof AdBlacklistsControlsCardView
> = memo(AdBlacklistsControlsCardView);

/** `AdBlacklistsPage` 主列表与分页视图订阅的状态与动作切片（不含 `searchInput`、`addFormOpen` 与 `addPackInput`）。 */
type AdBlacklistsPageViewSlice = Pick<
  MiniAppAdBlacklistsStoreState,
  | "kind"
  | "debouncedQuery"
  | "noticeBanner"
  | "loadingList"
  | "busyAction"
  | "stickerPageNumber"
  | "stickerPageSize"
  | "stickerPage"
  | "emojiPageNumber"
  | "emojiPageSize"
  | "emojiPage"
  | "stickerTotal"
  | "emojiTotal"
  | "loadCurrentList"
  | "selectKind"
  | "dismissNoticeBanner"
  | "openPreview"
  | "removePack"
  | "setPageNumber"
  | "setPageSize"
>;

/**
 * 从内容黑名单仓库提取主列表、页签与分页视图所需的切片（不含输入草稿与添加面板展开态）。
 *
 * @param state 内容黑名单仓库完整状态快照
 * @returns 主列表与分页视图切片
 */
function selectAdBlacklistsPageViewSlice(
  state: MiniAppAdBlacklistsStoreState
): AdBlacklistsPageViewSlice {
  return {
    kind: state.kind,
    debouncedQuery: state.debouncedQuery,
    noticeBanner: state.noticeBanner,
    loadingList: state.loadingList,
    busyAction: state.busyAction,
    stickerPageNumber: state.stickerPageNumber,
    stickerPageSize: state.stickerPageSize,
    stickerPage: state.stickerPage,
    emojiPageNumber: state.emojiPageNumber,
    emojiPageSize: state.emojiPageSize,
    emojiPage: state.emojiPage,
    stickerTotal: state.stickerTotal,
    emojiTotal: state.emojiTotal,
    loadCurrentList: state.loadCurrentList,
    selectKind: state.selectKind,
    dismissNoticeBanner: state.dismissNoticeBanner,
    openPreview: state.openPreview,
    removePack: state.removePack,
    setPageNumber: state.setPageNumber,
    setPageSize: state.setPageSize,
  };
}

/**
 * 内容黑名单（贴纸包与自定义表情包）管理页面：
 * 支持贴纸包 / 自定义表情包双子页签、0.5s 防抖搜索、默认收起的上拉/下拉折叠添加表单（支持纯 short name 与 Telegram 贴纸/表情包分享链接并自动归类切换页签）、页内包预览弹窗、二次确认移除与统一分页。
 *
 * @param props 可选仓库工厂属性
 * @returns React 节点
 */
export function AdBlacklistsPage({
  storeFactory = createAdBlacklistsStore,
}: AdBlacklistsPageProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const store: MiniAppAdBlacklistsStore = useComponentStoreApi(storeFactory);
  const {
    kind,
    debouncedQuery,
    noticeBanner,
    loadingList,
    busyAction,
    stickerPageNumber,
    stickerPageSize,
    stickerPage,
    emojiPageNumber,
    emojiPageSize,
    emojiPage,
    stickerTotal,
    emojiTotal,
    loadCurrentList,
    selectKind,
    dismissNoticeBanner,
    openPreview,
    removePack,
    setPageNumber,
    setPageSize,
  }: AdBlacklistsPageViewSlice = useStore(
    store,
    useShallow(selectAdBlacklistsPageViewSlice)
  );

  useEffect((): void => {
    void loadCurrentList();
  }, [
    debouncedQuery,
    emojiPageNumber,
    emojiPageSize,
    kind,
    loadCurrentList,
    stickerPageNumber,
    stickerPageSize,
  ]);

  useEffect((): (() => void) => {
    return (): void => {
      store.getState().closePreview();
    };
  }, [store]);

  const handleRefresh: () => void = useCallback((): void => {
    void loadCurrentList();
  }, [loadCurrentList]);

  const activePage: Readonly<MiniAppAdBlacklistsResponse> | null =
    kind === "sticker" ? stickerPage : emojiPage;
  const activePageNumber: number =
    kind === "sticker" ? stickerPageNumber : emojiPageNumber;
  const activePageSize: number =
    kind === "sticker" ? stickerPageSize : emojiPageSize;
  const activeKindTotal: number =
    kind === "sticker" ? stickerTotal : emojiTotal;

  return (
    <section className="animate-fade-in ad-blacklists-page">
      <div className="subtabs-bar ad-blacklists-subtabs-bar">
        <div className="subtabs-group">
          {MINI_APP_AD_BLACKLIST_KINDS.map(
            (tabKind: MiniAppAdBlacklistKind): React.JSX.Element => {
              const isActive: boolean = kind === tabKind;
              const tabLabel: string =
                tabKind === "sticker"
                  ? t.adBlacklists.stickerTab
                  : t.adBlacklists.emojiTab;
              return (
                <button
                  key={tabKind}
                  type="button"
                  className={`subtab-btn ${tabKind === "emoji" ? "danger-tab" : ""} ${isActive ? "active" : ""}`}
                  disabled={busyAction}
                  onClick={(): void => {
                    selectKind(tabKind);
                  }}
                >
                  <span>{tabLabel}</span>
                </button>
              );
            }
          )}
        </div>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loadingList || busyAction}
          onClick={handleRefresh}
        >
          <RefreshSvgIcon size={14} className={loadingList ? "spin-icon" : ""} />
          <span>{t.adBlacklists.refreshButton}</span>
        </button>
      </div>

      <InlineNoticeCollapse activeValue={noticeBanner} resetKey={kind}>
        {(banner: Readonly<MiniAppAdBlacklistNoticeBanner>): React.JSX.Element => (
          <div className="duplicate-alert-banner ad-blacklist-notice-banner" role="alert">
            <div className="duplicate-alert-content">
              <AlertSvgIcon size={18} />
              <div>
                <div className="duplicate-alert-title">
                  {banner.kind === "duplicate"
                    ? t.adBlacklists.duplicateBannerTitle
                    : t.adBlacklists.noticeBannerTitle}
                </div>
                <div className="duplicate-alert-desc">{banner.message}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn icon-btn"
              aria-label={t.adBlacklists.dismissNoticeAria}
              onClick={dismissNoticeBanner}
            >
              <CloseSvgIcon size={14} />
            </button>
          </div>
        )}
      </InlineNoticeCollapse>

      <AdBlacklistsControlsCard store={store} />

      <div className="card ad-blacklist-list-card">
        {loadingList
          ? (
            <LoadingBox>
              <ListSkeletonRows count={MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE} />
            </LoadingBox>
          )
          : null}

        {!loadingList && activePage !== null && activePage.items.length === 0
          ? (
            <div className="empty">
              {debouncedQuery.length > 0
                ? t.adBlacklists.emptySearchHint(debouncedQuery)
                : t.adBlacklists.emptyListHint(kind)}
            </div>
          )
          : null}

        {!loadingList && activePage !== null && activePage.items.length > 0
          ? (
            <Fragment>
              {activePage.items.map(
                (item: Readonly<MiniAppAdBlacklistItem>): React.JSX.Element => {
                  const packUrl: string = buildAdBlacklistPackUrl(kind, item.pack);
                  return (
                    <div key={item.pack} className="row ad-blacklist-row">
                      <div className="row-main">
                        <button
                          type="button"
                          className="ad-blacklist-pack-link"
                          title={t.adBlacklists.previewPackButtonTitle(kind)}
                          onClick={(): void => {
                            void openPreview(item.pack);
                          }}
                        >
                          <span className="ad-blacklist-pack-name" dir="ltr">
                            {item.pack}
                          </span>
                          <EyeSvgIcon
                            size={13}
                            className="ad-blacklist-link-icon"
                          />
                        </button>
                        <div className="row-sub ad-blacklist-pack-url" dir="ltr" title={packUrl}>
                          {packUrl}
                        </div>
                      </div>
                      <div className="toolbar-actions ad-blacklist-row-actions">
                        <button
                          type="button"
                          className="btn danger icon-btn ad-blacklist-remove-btn"
                          disabled={busyAction}
                          onClick={(): void => {
                            void removePack(item.pack);
                          }}
                        >
                          <TrashSvgIcon size={14} />
                          <span>{t.adBlacklists.removeButton}</span>
                        </button>
                      </div>
                    </div>
                  );
                }
              )}
            </Fragment>
          )
          : null}

        <PaginationBar
          page={activePage?.page ?? activePageNumber}
          totalPages={activePage?.totalPages ?? 1}
          total={activePage?.total ?? activeKindTotal}
          pageSize={activePage?.pageSize ?? activePageSize}
          pageSizeOptions={MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS}
          disabled={loadingList || busyAction}
          onPageChange={setPageNumber}
          onPageSizeChange={setPageSize}
        />
      </div>

      <AdBlacklistPreviewModal store={store} />
    </section>
  );
}
