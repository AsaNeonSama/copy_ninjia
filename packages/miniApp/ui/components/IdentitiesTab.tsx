import { useCallback, useEffect, useState } from "react";
import type React from "react";
import {
  MINI_APP_IDENTITY_ADD_MODES,
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
  MINI_APP_SEARCH_DEBOUNCE_MS,
} from "../../../consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../../consts/whitelist";
import type { WhitelistPermissionKey } from "../../../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityAddMode,
  MiniAppIdentityMutationResult,
  MiniAppIdentitySubTabKey,
  MiniAppLanguage,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
  TelegramWebApp,
} from "../../../types/miniApp";
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
} from "../../miniAppResoures";
import type { PrepareMiniAppPickerResult } from "../../picker";
import {
  fetchMiniAppBlocklist,
  fetchMiniAppWhitelist,
  getTelegramWebApp,
  pollMiniAppPickerResult,
  requestMiniAppPreparedPicker,
  setMiniAppBlocklistMembership,
  setMiniAppWhitelistMembership,
} from "../api";
import { sanitizeBidiText, truncateDisplayText } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";
import { PaginationBar } from "./PaginationBar";
import { PermissionDrawer } from "./PermissionDrawer";

/** `IdentitiesTab` 组件的属性参数。 */
export interface IdentitiesTabProps {
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

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
 * @param props 组件属性
 * @returns React 节点
 */
export function IdentitiesTab({ onToast }: IdentitiesTabProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const showStoreToast: (text: string, tone?: "info" | "warning" | "danger") => void =
    useMiniAppStore(
      (state: MiniAppUiStoreState): ((text: string, tone?: "info" | "warning" | "danger") => void) =>
        state.showToast
    );
  const requestConfirm: (
    message: string,
    tone?: "danger" | "primary"
  ) => Promise<boolean> = useMiniAppStore(
    (state: MiniAppUiStoreState): ((message: string, tone?: "danger" | "primary") => Promise<boolean>) =>
      state.requestConfirm
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [subTab, setSubTab]: [
    MiniAppIdentitySubTabKey,
    React.Dispatch<React.SetStateAction<MiniAppIdentitySubTabKey>>
  ] = useState<MiniAppIdentitySubTabKey>("whitelist");

  const [searchInput, setSearchInput]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");
  const [debouncedQuery, setDebouncedQuery]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");

  const [addMenuOpen, setAddMenuOpen]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [idFormOpen, setIdFormOpen]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [idInput, setIdInput]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");
  const [duplicateAlertText, setDuplicateAlertText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);

  const [busyAction, setBusyAction]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);
  const [loadingList, setLoadingList]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(false);

  const [whitelistPageNumber, setWhitelistPageNumber]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(1);
  const [whitelistPageSize, setWhitelistPageSize]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE);
  const [whitelistPage, setWhitelistPage]: [
    MiniAppWhitelistPage | null,
    React.Dispatch<React.SetStateAction<MiniAppWhitelistPage | null>>
  ] = useState<MiniAppWhitelistPage | null>(null);
  const [selectedEntryId, setSelectedEntryId]: [
    number | null,
    React.Dispatch<React.SetStateAction<number | null>>
  ] = useState<number | null>(null);

  const [blocklistPageNumber, setBlocklistPageNumber]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(1);
  const [blocklistPageSize, setBlocklistPageSize]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE);
  const [blocklistPage, setBlocklistPage]: [
    MiniAppBlocklistPage | null,
    React.Dispatch<React.SetStateAction<MiniAppBlocklistPage | null>>
  ] = useState<MiniAppBlocklistPage | null>(null);

  const [whitelistTotal, setWhitelistTotal]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(0);
  const [blocklistTotal, setBlocklistTotal]: [
    number,
    React.Dispatch<React.SetStateAction<number>>
  ] = useState<number>(0);

  useEffect((): (() => void) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      const nextTrimmed: string = searchInput.trim();
      setDebouncedQuery((prev: string): string => {
        if (prev !== nextTrimmed) {
          setWhitelistPageNumber(1);
          setBlocklistPageNumber(1);
        }
        return nextTrimmed;
      });
    }, MINI_APP_SEARCH_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(timer);
    };
  }, [searchInput]);

  const loadCurrentList: () => Promise<void> = useCallback(async (): Promise<void> => {
    setLoadingList(true);
    try {
      if (subTab === "whitelist") {
        const page: MiniAppWhitelistPage = await fetchMiniAppWhitelist(
          whitelistPageNumber,
          whitelistPageSize,
          debouncedQuery
        );
        setWhitelistPage(page);
        setWhitelistTotal(page.whitelistTotal);
        setBlocklistTotal(page.blocklistTotal);
        if (page.page !== whitelistPageNumber) {
          setWhitelistPageNumber(page.page);
        }
      } else {
        const page: MiniAppBlocklistPage = await fetchMiniAppBlocklist(
          blocklistPageNumber,
          blocklistPageSize,
          debouncedQuery
        );
        setBlocklistPage(page);
        setWhitelistTotal(page.whitelistTotal);
        setBlocklistTotal(page.blocklistTotal);
        if (page.page !== blocklistPageNumber) {
          setBlocklistPageNumber(page.page);
        }
      }
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setLoadingList(false);
    }
  }, [
    blocklistPageNumber,
    blocklistPageSize,
    debouncedQuery,
    onToast,
    subTab,
    whitelistPageNumber,
    whitelistPageSize,
  ]);

  useEffect((): void => {
    void loadCurrentList();
  }, [loadCurrentList]);

  const triggerDuplicateNotice = (idText: string): void => {
    const text: string = t.identities.duplicateToast(idText, subTab);
    setDuplicateAlertText(text);
    onToast(text);
    showStoreToast(text, "warning");
  };

  const handleAddById = async (): Promise<void> => {
    const trimmed: string = idInput.trim();
    const id: number = Number(trimmed);
    if (trimmed.length === 0 || !Number.isSafeInteger(id) || id === 0) {
      onToast(t.identities.invalidIdToast);
      showStoreToast(t.identities.invalidIdToast, "warning");
      return;
    }

    const alreadyInCurrentPage: boolean =
      subTab === "whitelist"
        ? (whitelistPage?.items.some(
          (item: Readonly<MiniAppWhitelistEntryView>): boolean => item.id === id
        ) ?? false)
        : (blocklistPage?.items.some(
          (item: Readonly<MiniAppBlocklistEntryView>): boolean => item.id === id
        ) ?? false);
    if (alreadyInCurrentPage) {
      triggerDuplicateNotice(`ID ${id}`);
      return;
    }

    setBusyAction(true);
    try {
      const result: MiniAppIdentityMutationResult =
        subTab === "whitelist"
          ? await setMiniAppWhitelistMembership(id, true)
          : await setMiniAppBlocklistMembership(id, true);

      if (result.duplicate === true || (result.ok && !result.changed)) {
        triggerDuplicateNotice(`ID ${id}`);
        return;
      }

      if (!result.ok) {
        onToast(result.message);
        showStoreToast(result.message, "danger");
        return;
      }

      setDuplicateAlertText(null);
      onToast(result.message);
      if (subTab === "whitelist") {
        setSelectedEntryId(id);
      }
      setIdInput("");
      setIdFormOpen(false);
      setAddMenuOpen(false);
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setBusyAction(false);
    }
  };

  const pollPickerSession = async (requestId: number): Promise<void> => {
    for (let attempt: number = 0; attempt < MINI_APP_PICKER_POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, MINI_APP_PICKER_POLL_INTERVAL_MS);
      });
      try {
        const result: Readonly<MiniAppPickerResultEvent> | null =
          await pollMiniAppPickerResult(requestId);
        if (result !== null) {
          if (result.duplicateIds !== undefined && result.duplicateIds.length > 0) {
            triggerDuplicateNotice(
              result.duplicateIds.map((dupId: number): string => `ID ${dupId}`).join(", ")
            );
          } else {
            onToast(result.summary);
          }
          await loadCurrentList();
          return;
        }
      } catch (_error: unknown) {
        return;
      }
    }
    onToast(t.identities.pickerTimeoutToast);
  };

  const handleOpenPicker = async (subjectKind: MiniAppPickerSubjectKind): Promise<void> => {
    const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
    if (typeof webApp?.requestChat !== "function") {
      onToast(t.identities.pickerUnsupportedHint);
      showStoreToast(t.identities.pickerUnsupportedHint, "warning");
      return;
    }
    setBusyAction(true);
    try {
      const prepared: Extract<PrepareMiniAppPickerResult, { readonly ok: true }> =
        await requestMiniAppPreparedPicker(subTab, subjectKind);
      setAddMenuOpen(false);
      setIdFormOpen(false);
      webApp.requestChat(prepared.preparedButtonId, (accepted: boolean): void => {
        if (!accepted) {
          onToast(t.identities.pickerCancelledToast);
          return;
        }
        onToast(t.identities.pickerWaitingToast);
        void pollPickerSession(prepared.requestId);
      });
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setBusyAction(false);
    }
  };

  const handleSelectAddMode = (mode: MiniAppIdentityAddMode): void => {
    if (mode === "id") {
      setIdFormOpen((prev: boolean): boolean => !prev);
      return;
    }
    void handleOpenPicker(mode);
  };

  const handleRemoveWhitelist = async (
    entry: Readonly<MiniAppWhitelistEntryView>
  ): Promise<void> => {
    if (
      !(await requestConfirm(
        t.identities.confirmRemoveWhitelist(
          truncateDisplayText(entry.displayName, 20),
          entry.id
        ),
        "danger"
      ))
    ) {
      return;
    }
    setBusyAction(true);
    try {
      const result: MiniAppIdentityMutationResult =
        await setMiniAppWhitelistMembership(entry.id, false);
      if (selectedEntryId === entry.id) setSelectedEntryId(null);
      onToast(result.message);
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setBusyAction(false);
    }
  };

  const handleRemoveBlocklist = async (
    entry: Readonly<MiniAppBlocklistEntryView>
  ): Promise<void> => {
    if (
      !(await requestConfirm(
        t.identities.confirmRemoveBlocklist(
          truncateDisplayText(entry.displayName, 20),
          entry.id
        ),
        "danger"
      ))
    ) {
      return;
    }
    setBusyAction(true);
    try {
      const result: MiniAppIdentityMutationResult =
        await setMiniAppBlocklistMembership(entry.id, false);
      onToast(result.message);
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(message);
    } finally {
      setBusyAction(false);
    }
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
              setSubTab("whitelist");
              setSelectedEntryId(null);
              setDuplicateAlertText(null);
            }}
          >
            <IdentitiesSvgIcon size={14} />
            <span>{t.identities.whitelistTab}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn danger-tab ${subTab === "blocklist" ? "active" : ""}`}
            onClick={(): void => {
              setSubTab("blocklist");
              setSelectedEntryId(null);
              setDuplicateAlertText(null);
            }}
          >
            <span>{t.identities.blocklistTab}</span>
          </button>
        </div>
        <button
          type="button"
          className="btn icon-btn"
          disabled={loadingList}
          onClick={(): void => {
            void loadCurrentList();
          }}
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
              onClick={(): void => {
                setDuplicateAlertText(null);
              }}
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
              placeholder={t.identities.searchPlaceholder(subTab)}
            />
            {searchInput.length > 0
              ? (
                <button
                  type="button"
                  className="search-clear-btn"
                  aria-label={t.identities.searchClearAria}
                  onClick={(): void => {
                    setSearchInput("");
                    setDebouncedQuery("");
                  }}
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
            onClick={(): void => {
              setAddMenuOpen((prev: boolean): boolean => !prev);
            }}
          >
            <PlusSvgIcon size={15} />
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
                        handleSelectAddMode(mode);
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
                        void handleAddById();
                      }}
                    >
                      {t.identities.idConfirmButton}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={(): void => {
                        setIdFormOpen(false);
                      }}
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
                <div className="loading-box">
                  <div className="spinner-ring" />
                  <div className="loading-text">{t.identities.loadingText}</div>
                  <div className="skeleton-stack">
                    <div className="skeleton-line wide" />
                    <div className="skeleton-line medium" />
                  </div>
                </div>
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
              return (
                <div key={entry.id} className="identity-row-group">
                  <div className="row">
                    <div className="row-main">
                      <div className="identity-title-row">
                        <bdi
                          className="identity-name"
                          title={sanitizeBidiText(entry.displayName)}
                        >
                          {truncateDisplayText(entry.displayName, 18)}
                        </bdi>
                        {entry.username !== undefined
                          ? (
                            <span
                              className="identity-username"
                              dir="ltr"
                              title={`@${sanitizeBidiText(entry.username)}`}
                            >
                              @{truncateDisplayText(entry.username, 16)}
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
                      <div className="row-sub">
                        ID: {entry.id} ·{" "}
                        {t.identities.enabledPermCountText(
                          enabledCount,
                          WHITELIST_PERMISSION_KEYS.length
                        )}
                      </div>
                    </div>
                    <div className="toolbar-actions">
                      <button
                        type="button"
                        className={`btn ${isExpanded ? "primary" : ""}`}
                        onClick={(): void => {
                          setSelectedEntryId(isExpanded ? null : entry.id);
                        }}
                      >
                        {t.identities.configurePermButton}
                      </button>
                      <button
                        type="button"
                        className="btn danger icon-btn"
                        disabled={busyAction}
                        onClick={(): void => {
                          void handleRemoveWhitelist(entry);
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
                        onUpdated={(): void => {
                          void loadCurrentList();
                        }}
                        onClose={(): void => {
                          setSelectedEntryId(null);
                        }}
                        onToast={onToast}
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
              onPageChange={(nextPage: number): void => {
                setWhitelistPageNumber(nextPage);
              }}
              onPageSizeChange={(nextPageSize: number): void => {
                setWhitelistPageNumber(1);
                setWhitelistPageSize(nextPageSize);
              }}
            />
          </div>
        )
        : (
          <div className="card">
            {loadingList && blocklistPage === null
              ? (
                <div className="loading-box">
                  <div className="spinner-ring" />
                  <div className="loading-text">{t.identities.loadingText}</div>
                  <div className="skeleton-stack">
                    <div className="skeleton-line wide" />
                    <div className="skeleton-line medium" />
                  </div>
                </div>
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

            {blocklistPage?.items.map((entry: Readonly<MiniAppBlocklistEntryView>): React.JSX.Element => (
              <div key={entry.id} className="row">
                <div className="row-main">
                  <div className="identity-title-row">
                    <bdi
                      className="identity-name"
                      title={sanitizeBidiText(entry.displayName)}
                    >
                      {truncateDisplayText(entry.displayName, 18)}
                    </bdi>
                    {entry.username !== undefined
                      ? (
                        <span
                          className="identity-username"
                          dir="ltr"
                          title={`@${sanitizeBidiText(entry.username)}`}
                        >
                          @{truncateDisplayText(entry.username, 16)}
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
                  <div className="row-sub">
                    ID: {entry.id} · {t.identities.blockedAtText(entry.blockedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn danger icon-btn"
                  disabled={busyAction}
                  onClick={(): void => {
                    void handleRemoveBlocklist(entry);
                  }}
                >
                  <TrashSvgIcon size={13} />
                  <span>{t.identities.removeBlocklistButton}</span>
                </button>
              </div>
            ))}

            <PaginationBar
              page={blocklistPage?.page ?? blocklistPageNumber}
              totalPages={blocklistPage?.totalPages ?? 1}
              total={blocklistPage?.total ?? blocklistTotal}
              pageSize={blocklistPage?.pageSize ?? blocklistPageSize}
              pageSizeOptions={MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS}
              disabled={loadingList || busyAction}
              onPageChange={(nextPage: number): void => {
                setBlocklistPageNumber(nextPage);
              }}
              onPageSizeChange={(nextPageSize: number): void => {
                setBlocklistPageNumber(1);
                setBlocklistPageSize(nextPageSize);
              }}
            />
          </div>
        )}
    </section>
  );
}
