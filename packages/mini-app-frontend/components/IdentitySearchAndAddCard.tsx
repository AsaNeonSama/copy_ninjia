import { memo, useRef } from "react";
import type React from "react";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import {
  ChevronDownSvgIcon,
  CloseSvgIcon,
  PlusSvgIcon,
  SearchSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppIdentitiesStoreState } from "../store/identities";
import type { MiniAppLanguage } from "../types/miniApp";
import { AddModeButtonList } from "./AddModeButtonList";
import { CollapseGrid } from "./animations/CollapseGrid";

/** `IdentitySearchAndAddCard` 组件属性参数。 */
export interface IdentitySearchAndAddCardProps {
  /** 黑白名单与权限矩阵状态仓库快照。 */
  readonly state: MiniAppIdentitiesStoreState;
}

/**
 * 比较搜索与添加卡片所需的状态切片是否一致，使展开/收起列表项的权限抽屉时不触发本卡片重渲染。
 *
 * @param prev 上一次属性
 * @param next 本次属性
 * @returns 状态切片未变化时返回 `true`
 */
function areIdentitySearchAndAddCardPropsEqual(
  prev: Readonly<IdentitySearchAndAddCardProps>,
  next: Readonly<IdentitySearchAndAddCardProps>
): boolean {
  const a: MiniAppIdentitiesStoreState = prev.state;
  const b: MiniAppIdentitiesStoreState = next.state;
  return (
    a.searchInput === b.searchInput &&
    a.debouncedQuery === b.debouncedQuery &&
    a.addMenuOpen === b.addMenuOpen &&
    a.idFormOpen === b.idFormOpen &&
    a.idInput === b.idInput &&
    a.busyAction === b.busyAction
  );
}

/**
 * 渲染黑白名单顶部的防抖搜索栏与折叠式三合一添加抽屉卡片（含按 ID 输入内联展开区）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function IdentitySearchAndAddCardView({
  state,
}: IdentitySearchAndAddCardProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (uiState: MiniAppUiStoreState): MiniAppLanguage => uiState.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
  const {
    searchInput,
    debouncedQuery,
    addMenuOpen,
    idFormOpen,
    idInput,
    busyAction,
    setSearchInput,
    clearSearch,
    toggleAddMenu,
    selectAddMode,
    closeIdForm,
    setIdInput,
    addById,
  }: MiniAppIdentitiesStoreState = state;
  const isDebouncing: boolean = searchInput.trim() !== debouncedQuery;
  const closingIdInputRef: React.RefObject<string> = useRef<string>(idInput);
  if (addMenuOpen && idFormOpen) {
    closingIdInputRef.current = idInput;
  }
  const closingMenuSnapshotRef: React.RefObject<{
    readonly idFormOpen: boolean;
    readonly busyAction: boolean;
  }> = useRef<{ readonly idFormOpen: boolean; readonly busyAction: boolean }>({
    idFormOpen,
    busyAction,
  });
  if (addMenuOpen) {
    closingMenuSnapshotRef.current = {
      idFormOpen,
      busyAction,
    };
  }
  const displayIdFormOpen: boolean = addMenuOpen
    ? idFormOpen
    : closingMenuSnapshotRef.current.idFormOpen;
  const displayBusyAction: boolean =
    addMenuOpen && idFormOpen
      ? busyAction
      : closingMenuSnapshotRef.current.busyAction;
  const displayIdInput: string =
    addMenuOpen && idFormOpen ? idInput : closingIdInputRef.current;

  return (
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

      {isDebouncing
        ? (
          <div className="debounce-status-hint">
            {t.identities.searchDebounceHint}
          </div>
        )
        : null}

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

/** 按搜索与添加抽屉相关状态切片浅比较跳过重渲染的顶部搜索与添加卡片。 */
export const IdentitySearchAndAddCard: React.MemoExoticComponent<
  typeof IdentitySearchAndAddCardView
> = memo(IdentitySearchAndAddCardView, areIdentitySearchAndAddCardPropsEqual);
