import type React from "react";
import { MINI_APP_IDENTITY_ADD_MODES } from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import {
  ChannelSvgIcon,
  ChevronDownSvgIcon,
  CloseSvgIcon,
  HashtagSvgIcon,
  PlusSvgIcon,
  SearchSvgIcon,
  UserSvgIcon,
} from "../resource";
import { useMiniAppStore } from "../store/app";
import type { MiniAppUiStoreState } from "../store/app";
import type { MiniAppIdentitiesStoreState } from "../store/identities";
import type { MiniAppIdentityAddMode, MiniAppLanguage } from "../types/miniApp";
import { CollapseGrid } from "./animations/CollapseGrid";

/** `IdentitySearchAndAddCard` 组件属性参数。 */
export interface IdentitySearchAndAddCardProps {
  /** 黑白名单与权限矩阵状态仓库快照。 */
  readonly state: MiniAppIdentitiesStoreState;
}

/**
 * 根据添加模式键渲染对应的 SVG 图标。
 *
 * @param mode 添加模式键
 * @returns SVG 图标元素
 */
function renderAddModeIcon(mode: MiniAppIdentityAddMode): React.JSX.Element {
  if (mode === "id") return <HashtagSvgIcon size={14} />;
  if (mode === "users") return <UserSvgIcon size={14} />;
  return <ChannelSvgIcon size={14} />;
}

/**
 * 渲染黑白名单顶部的防抖搜索栏与折叠式三合一添加抽屉卡片（含按 ID 输入内联展开区）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function IdentitySearchAndAddCard({
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
          <div className="add-mode-grid">
            {MINI_APP_IDENTITY_ADD_MODES.map(
              (mode: MiniAppIdentityAddMode): React.JSX.Element => (
                <button
                  key={mode}
                  type="button"
                  className={`add-mode-card ${mode === "id" && idFormOpen ? "active" : ""}`}
                  disabled={busyAction || !addMenuOpen}
                  tabIndex={addMenuOpen ? 0 : -1}
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

          <CollapseGrid
            expanded={idFormOpen}
            gridClassName="id-add-collapse-grid"
            innerClassName="id-add-collapse-inner"
          >
            <div className="id-add-inline-row">
              <input
                type="text"
                value={idInput}
                disabled={busyAction || !idFormOpen}
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
                disabled={busyAction || !idFormOpen}
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
                disabled={!idFormOpen}
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
