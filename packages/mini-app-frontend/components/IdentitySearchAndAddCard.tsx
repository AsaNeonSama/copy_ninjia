import { memo, useEffect, useState } from "react";
import type React from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { MINI_APP_SEARCH_DEBOUNCE_MS } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { readEventTargetValue } from "../libs/formatters";
import {
  ChevronDownSvgIcon,
  CloseSvgIcon,
  PlusSvgIcon,
  SearchSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type {
  MiniAppIdentitiesStore,
  MiniAppIdentitiesStoreState,
} from "../store/identities";
import type { MiniAppLanguage } from "../types/miniApp";
import { AddModeButtonList } from "./AddModeButtonList";
import { CollapseGrid } from "./animations/CollapseGrid";
import { useClosingSnapshot } from "./animations/useDelayedUnmount";

/** `IdentitySearchAndAddCard` 顶部搜索栏与折叠添加抽屉订阅的状态与动作切片。 */
type IdentitySearchAndAddCardSlice = Pick<
  MiniAppIdentitiesStoreState,
  | "searchInput"
  | "addMenuOpen"
  | "idFormOpen"
  | "idInput"
  | "busyAction"
  | "setSearchInput"
  | "commitSearchQuery"
  | "clearSearch"
  | "toggleAddMenu"
  | "selectAddMode"
  | "closeIdForm"
  | "setIdInput"
  | "addById"
>;

/** `IdentitySearchAndAddCard` 组件属性参数。 */
export interface IdentitySearchAndAddCardProps {
  /** 黑白名单与权限矩阵状态仓库实例；卡片按切片自订阅。 */
  readonly store: MiniAppIdentitiesStore;
}

/**
 * 从黑白名单仓库提取顶部搜索与折叠添加卡片所需切片。
 *
 * @param state 黑白名单完整状态快照
 * @returns 搜索与添加卡片切片
 */
function selectIdentitySearchAndAddCardSlice(
  state: MiniAppIdentitiesStoreState
): IdentitySearchAndAddCardSlice {
  return {
    searchInput: state.searchInput,
    addMenuOpen: state.addMenuOpen,
    idFormOpen: state.idFormOpen,
    idInput: state.idInput,
    busyAction: state.busyAction,
    setSearchInput: state.setSearchInput,
    commitSearchQuery: state.commitSearchQuery,
    clearSearch: state.clearSearch,
    toggleAddMenu: state.toggleAddMenu,
    selectAddMode: state.selectAddMode,
    closeIdForm: state.closeIdForm,
    setIdInput: state.setIdInput,
    addById: state.addById,
  };
}

/**
 * 按切片订阅黑白名单仓库，渲染顶部的防抖搜索栏与折叠式三合一添加抽屉卡片（含按 ID 输入内联展开区）。
 *
 * @param props 状态仓库引用
 * @returns React 节点
 */
function IdentitySearchAndAddCardView({
  store,
}: IdentitySearchAndAddCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (uiState: MiniAppUiStoreState): MiniAppLanguage => uiState.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    searchInput,
    addMenuOpen,
    idFormOpen,
    idInput,
    busyAction,
    setSearchInput,
    commitSearchQuery,
    clearSearch,
    toggleAddMenu,
    selectAddMode,
    closeIdForm,
    setIdInput,
    addById,
  }: IdentitySearchAndAddCardSlice = useStore(
    store,
    useShallow(selectIdentitySearchAndAddCardSlice)
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

  const displayIdFormOpen: boolean = useClosingSnapshot(
    idFormOpen,
    addMenuOpen
  );
  const displayBusyAction: boolean = useClosingSnapshot(
    busyAction,
    addMenuOpen
  );
  const displayIdInput: string = useClosingSnapshot(
    idInput,
    addMenuOpen && idFormOpen
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
            placeholder={t.identities.searchPlaceholder}
          />
          {searchInput.length > 0
            ? (
              <button
                type="button"
                className="search-clear-btn"
                aria-label={t.identities.searchClearAria}
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
          className={`btn primary icon-btn add-fold-trigger ${addMenuOpen ? "open" : ""}`}
          disabled={busyAction}
          onClick={toggleAddMenu}
        >
          <PlusSvgIcon size={16} />
          <span>{t.identities.addFoldButton}</span>
          <ChevronDownSvgIcon
            size={14}
            className={`chevron-icon ${addMenuOpen ? "rotated" : ""}`}
          />
        </button>
      </div>

      <CollapseGrid
        expanded={addMenuOpen}
        gridClassName="add-fold-collapse-grid"
        innerClassName="add-fold-collapse-inner"
      >
        <div className="add-fold-panel">
          <AddModeButtonList
            idFormOpen={displayIdFormOpen}
            disabled={displayBusyAction}
            interactive={addMenuOpen}
            t={t}
            onSelectMode={selectAddMode}
          />

          <CollapseGrid
            expanded={displayIdFormOpen}
            gridClassName="id-add-collapse-grid"
            innerClassName="id-add-collapse-inner"
          >
            <div className="id-add-inline-row">
              <input
                type="text"
                value={displayIdInput}
                disabled={displayBusyAction}
                tabIndex={idFormOpen ? 0 : -1}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setIdInput(readEventTargetValue(event));
                }}
                placeholder={t.identities.idInputPlaceholder}
              />
              <button
                type="button"
                className="btn primary"
                disabled={displayBusyAction}
                tabIndex={idFormOpen ? 0 : -1}
                onClick={(): void => {
                  void addById();
                }}
              >
                {t.identities.idConfirmButton}
              </button>
              <button
                type="button"
                className="btn"
                disabled={displayBusyAction}
                tabIndex={idFormOpen ? 0 : -1}
                onClick={closeIdForm}
              >
                {t.identities.idCancelButton}
              </button>
            </div>
          </CollapseGrid>
        </div>
      </CollapseGrid>
    </div>
  );
}

/** 仓库引用不变时跳过父级重渲染的顶部搜索与添加卡片（卡片内部按切片自订阅）。 */
export const IdentitySearchAndAddCard: React.MemoExoticComponent<
  typeof IdentitySearchAndAddCardView
> = memo(IdentitySearchAndAddCardView);
