import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { WHITELIST_PERMISSION_KEYS } from "../../../consts/whitelist";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
} from "../../../consts/miniApp";
import type { WhitelistPermissionKey } from "../../../types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppBlocklistPage,
  MiniAppIdentityMutationResult,
  MiniAppIdentitySubTabKey,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppWhitelistEntryView,
  MiniAppWhitelistPage,
  TelegramWebApp,
} from "../../../types/miniApp";
import type { PrepareMiniAppPickerResult } from "../../picker";
import {
  confirmMiniAppAction,
  fetchMiniAppBlocklist,
  fetchMiniAppWhitelist,
  getTelegramWebApp,
  pollMiniAppPickerResult,
  requestMiniAppPreparedPicker,
  setMiniAppBlocklistMembership,
  setMiniAppWhitelistMembership,
} from "../api";
import { sanitizeBidiText } from "../formatters";
import { PaginationBar } from "./PaginationBar";
import { PermissionDrawer } from "./PermissionDrawer";

/** `IdentitiesTab` 组件的属性参数。 */
export interface IdentitiesTabProps {
  /** 全局提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * 黑白名单与权限矩阵管理组件（支持页码分页、总量统计、数字 ID 添加及 `requestChat` 原生好友/联系人/频道选择器添加）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function IdentitiesTab({ onToast }: IdentitiesTabProps): React.JSX.Element {
  const [subTab, setSubTab]: [
    MiniAppIdentitySubTabKey,
    React.Dispatch<React.SetStateAction<MiniAppIdentitySubTabKey>>
  ] = useState<MiniAppIdentitySubTabKey>("whitelist");
  const [idInput, setIdInput]: [
    string,
    React.Dispatch<React.SetStateAction<string>>
  ] = useState<string>("");
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

  const loadCurrentList: () => Promise<void> = useCallback(async (): Promise<void> => {
    setLoadingList(true);
    try {
      if (subTab === "whitelist") {
        const page: MiniAppWhitelistPage = await fetchMiniAppWhitelist(
          whitelistPageNumber,
          whitelistPageSize
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
          blocklistPageSize
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
      onToast(`加载名单失败: ${message}`);
    } finally {
      setLoadingList(false);
    }
  }, [blocklistPageNumber, blocklistPageSize, onToast, subTab, whitelistPageNumber, whitelistPageSize]);

  useEffect((): void => {
    void loadCurrentList();
  }, [loadCurrentList]);

  const handleAddById = async (): Promise<void> => {
    const trimmed: string = idInput.trim();
    const id: number = Number(trimmed);
    if (trimmed.length === 0 || !Number.isSafeInteger(id) || id === 0) {
      onToast("请输入有效的用户正整数 ID 或 -100 开头的频道 ID");
      return;
    }
    setBusyAction(true);
    try {
      if (subTab === "whitelist") {
        const result: MiniAppIdentityMutationResult =
          await setMiniAppWhitelistMembership(id, true);
        onToast(result.message);
        setSelectedEntryId(id);
      } else {
        const result: MiniAppIdentityMutationResult =
          await setMiniAppBlocklistMembership(id, true);
        onToast(result.message);
      }
      setIdInput("");
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(`添加失败: ${message}`);
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
          onToast(result.summary);
          await loadCurrentList();
          return;
        }
      } catch (_error: unknown) {
        return;
      }
    }
  };

  const handleOpenPicker = async (subjectKind: MiniAppPickerSubjectKind): Promise<void> => {
    const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
    if (typeof webApp?.requestChat !== "function") {
      onToast("当前 Telegram 客户端版本不支持 requestChat 原生选择器，请升级客户端或使用 ID 添加");
      return;
    }
    setBusyAction(true);
    try {
      const prepared: Extract<PrepareMiniAppPickerResult, { readonly ok: true }> =
        await requestMiniAppPreparedPicker(subTab, subjectKind);
      webApp.requestChat(prepared.preparedButtonId, (accepted: boolean): void => {
        if (!accepted) {
          onToast("已取消选择");
          return;
        }
        onToast("正在同步所选身份…");
        void pollPickerSession(prepared.requestId);
      });
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(`唤起选择器失败: ${message}`);
    } finally {
      setBusyAction(false);
    }
  };

  const handleRemoveWhitelist = async (id: number): Promise<void> => {
    if (!confirmMiniAppAction(`确认从白名单移除 ${id} 吗？`)) return;
    setBusyAction(true);
    try {
      const result: MiniAppIdentityMutationResult =
        await setMiniAppWhitelistMembership(id, false);
      if (selectedEntryId === id) setSelectedEntryId(null);
      onToast(result.message);
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(`移除失败: ${message}`);
    } finally {
      setBusyAction(false);
    }
  };

  const handleRemoveBlocklist = async (id: number): Promise<void> => {
    if (!confirmMiniAppAction(`确认从黑名单解封 ${id} 吗？`)) return;
    setBusyAction(true);
    try {
      const result: MiniAppIdentityMutationResult =
        await setMiniAppBlocklistMembership(id, false);
      onToast(result.message);
      await loadCurrentList();
    } catch (error: unknown) {
      const message: string = error instanceof Error ? error.message : String(error);
      onToast(`解封失败: ${message}`);
    } finally {
      setBusyAction(false);
    }
  };

  return (
    <section>
      <div className="subtabs-bar">
        <div className="subtabs-group">
          <button
            type="button"
            className={`subtab-btn ${subTab === "whitelist" ? "active" : ""}`}
            onClick={(): void => {
              setSubTab("whitelist");
              setSelectedEntryId(null);
            }}
          >
            <span>白名单与权限</span>
            <span className="subtab-count">{whitelistTotal}</span>
          </button>
          <button
            type="button"
            className={`subtab-btn danger-tab ${subTab === "blocklist" ? "active" : ""}`}
            onClick={(): void => {
              setSubTab("blocklist");
              setSelectedEntryId(null);
            }}
          >
            <span>黑名单</span>
            <span className="subtab-count">{blocklistTotal}</span>
          </button>
        </div>
        <button
          type="button"
          className="btn"
          disabled={loadingList}
          onClick={(): void => {
            void loadCurrentList();
          }}
        >
          刷新
        </button>
      </div>

      <div className="card">
        <div className="input-group" style={{ marginTop: 0 }}>
          <input
            type="text"
            value={idInput}
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
              const nextValue: string = (
                event.currentTarget as unknown as { readonly value: string }
              ).value;
              setIdInput(nextValue);
            }}
            placeholder={`输入用户 ID 或 -100 频道 ID 添加至${subTab === "whitelist" ? "白名单" : "黑名单"}`}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busyAction}
            onClick={(): void => {
              void handleAddById();
            }}
          >
            + ID 添加
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyAction}
            onClick={(): void => {
              void handleOpenPicker("users");
            }}
          >
            👤 选好友/联系人
          </button>
          <button
            type="button"
            className="btn"
            disabled={busyAction}
            onClick={(): void => {
              void handleOpenPicker("channel");
            }}
          >
            📢 选频道
          </button>
        </div>
      </div>

      {subTab === "whitelist"
        ? (
          <div className="card">
            <div className="card-title">
              <span>白名单条目列表</span>
              <span className="badge ok">
                共 {whitelistPage?.total ?? whitelistTotal} 条 · 第 {whitelistPage?.page ?? whitelistPageNumber} / {whitelistPage?.totalPages ?? 1} 页
              </span>
            </div>

            {whitelistPage !== null && whitelistPage.items.length === 0
              ? <div className="empty">白名单为空</div>
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
                        <bdi className="identity-name">
                          {sanitizeBidiText(entry.displayName)}
                        </bdi>
                        {entry.username !== undefined
                          ? (
                            <span className="identity-username" dir="ltr">
                              @{sanitizeBidiText(entry.username)}
                            </span>
                          )
                          : null}
                        <span className="badge">
                          {entry.isChannel ? "频道" : "用户"}
                        </span>
                      </div>
                      <div className="row-sub">
                        ID: {entry.id} · 已开启权限: {enabledCount} / {WHITELIST_PERMISSION_KEYS.length}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button
                        type="button"
                        className={`btn ${isExpanded ? "primary" : ""}`}
                        onClick={(): void => {
                          setSelectedEntryId(isExpanded ? null : entry.id);
                        }}
                      >
                        {isExpanded ? "收起权限" : "权限开关"}
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        disabled={busyAction}
                        onClick={(): void => {
                          void handleRemoveWhitelist(entry.id);
                        }}
                      >
                        移除
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
            <div className="card-title">
              <span>黑名单条目列表</span>
              <span className="badge warn">
                共 {blocklistPage?.total ?? blocklistTotal} 条 · 第 {blocklistPage?.page ?? blocklistPageNumber} / {blocklistPage?.totalPages ?? 1} 页
              </span>
            </div>

            {blocklistPage !== null && blocklistPage.items.length === 0
              ? <div className="empty">黑名单为空</div>
              : null}

            {blocklistPage?.items.map((entry: Readonly<MiniAppBlocklistEntryView>): React.JSX.Element => (
              <div key={entry.id} className="row">
                <div className="row-main">
                  <div className="identity-title-row">
                    <bdi className="identity-name">
                      {sanitizeBidiText(entry.displayName)}
                    </bdi>
                    {entry.username !== undefined
                      ? (
                        <span className="identity-username" dir="ltr">
                          @{sanitizeBidiText(entry.username)}
                        </span>
                      )
                      : null}
                    <span className="badge warn">
                      {entry.isChannel ? "频道" : "用户"}
                    </span>
                  </div>
                  <div className="row-sub">
                    ID: {entry.id} · 封禁时间: {entry.blockedAt}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn danger"
                  disabled={busyAction}
                  onClick={(): void => {
                    void handleRemoveBlocklist(entry.id);
                  }}
                >
                  解封
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
