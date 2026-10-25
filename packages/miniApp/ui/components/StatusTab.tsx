import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../../../consts/miniApp";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppLanguage,
  MiniAppStatusView,
} from "../../../types/miniApp";
import { RefreshSvgIcon, StatusSvgIcon } from "../../miniAppResoures";
import { fetchMiniAppStatus } from "../api";
import { formatBytes, formatTime, formatUptime } from "../formatters";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { useMiniAppStore } from "../store";
import type { MiniAppUiStoreState } from "../store";

/** `StatusTab` 组件的属性参数。 */
export interface StatusTabProps {
  /** 顶层鉴权门禁阶段已预拉取的初始状态快照。 */
  readonly initialStatus?: MiniAppStatusView | null;
  /** 当成功获取状态快照时同步通知顶层状态栏。 */
  readonly onStatusLoaded: (status: MiniAppStatusView) => void;
  /** 全局错误/操作提示回调。 */
  readonly onToast: (message: string) => void;
}

/**
 * 首页实时状态看板组件（每 3 秒自动刷新一次进程资源、会话、Telegram 出站与模型就绪状态）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function StatusTab({
  initialStatus = null,
  onStatusLoaded,
  onToast,
}: StatusTabProps): React.JSX.Element {
  const language: MiniAppLanguage = useMiniAppStore(
    (state: MiniAppUiStoreState): MiniAppLanguage => state.language
  );
  const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);

  const [status, setStatus]: [
    MiniAppStatusView | null,
    React.Dispatch<React.SetStateAction<MiniAppStatusView | null>>
  ] = useState<MiniAppStatusView | null>(initialStatus);
  const [loading, setLoading]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(initialStatus === null);
  const [errorText, setErrorText]: [
    string | null,
    React.Dispatch<React.SetStateAction<string | null>>
  ] = useState<string | null>(null);

  const loadStatus: (showErrorToast: boolean) => Promise<void> = useCallback(
    async (showErrorToast: boolean): Promise<void> => {
      try {
        const next: MiniAppStatusView = await fetchMiniAppStatus();
        setStatus(next);
        setErrorText(null);
        onStatusLoaded(next);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        setErrorText(message);
        if (showErrorToast) {
          onToast(message);
        }
      } finally {
        setLoading(false);
      }
    },
    [onStatusLoaded, onToast]
  );

  useEffect((): (() => void) => {
    void loadStatus(false);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => {
      void loadStatus(false);
    }, MINI_APP_STATUS_POLL_INTERVAL_MS);
    return (): void => {
      clearInterval(timer);
    };
  }, [loadStatus]);

  return (
    <section className="animate-fade-in">
      <div className="toolbar">
        <span className="toolbar-hint">
          <span className="toolbar-icon-badge">
            <StatusSvgIcon size={15} className="pulse-icon" />
          </span>
          <span>
            {status !== null
              ? t.status.updatedAtSub(formatTime(status.generatedAt))
              : t.status.loadingText}
          </span>
        </span>
        <button
          type="button"
          className="btn icon-btn"
          onClick={(): void => {
            void loadStatus(true);
          }}
        >
          <RefreshSvgIcon size={14} />
          <span>{t.chats.refreshButton}</span>
        </button>
      </div>

      {loading && status === null
        ? (
          <div className="card loading-box">
            <div className="spinner-ring" />
            <div className="loading-text">{t.status.loadingText}</div>
            <div className="skeleton-stack">
              <div className="skeleton-line wide" />
              <div className="skeleton-line medium" />
            </div>
          </div>
        )
        : null}

      {errorText !== null && status === null
        ? (
          <div className="card">
            <div className="empty danger-text">{errorText}</div>
          </div>
        )
        : null}

      {status !== null
        ? (
          <>
            <div className="card">
              <div className="card-title">
                <span>{t.tabs.status}</span>
                <span className="badge ok">
                  {t.status.updatedAtSub(formatTime(status.generatedAt))}
                </span>
              </div>
              <div className="grid-2">
                <div className="stat-box">
                  <div className="stat-label">{t.status.uptimeLabel}</div>
                  <div className="stat-value">{formatUptime(status.uptimeMs)}</div>
                  <div className="stat-sub">{t.status.updatedAtSub(formatTime(status.generatedAt))}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">{t.status.cpuLoadLabel}</div>
                  <div className="stat-value">{status.cpuAveragePercent.toFixed(2)}%</div>
                  <div className="stat-sub">{t.status.cpuLoadSub}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">{t.status.memoryPeakLabel}</div>
                  <div className="stat-value">{formatBytes(status.memoryPeakRssBytes)}</div>
                  <div className="stat-sub">
                    {t.status.memorySub(
                      formatBytes(status.memoryCurrentRssBytes),
                      formatBytes(status.memoryHeapUsedBytes)
                    )}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">{t.status.managedChatsLabel}</div>
                  <div className="stat-value">{status.managedChatCount}</div>
                  <div className="stat-sub">
                    {t.status.managedChatsSub(status.whitelistCount, status.blocklistCount)}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">{t.status.activeSessionsLabel}</div>
                  <div className="stat-value">{status.activeSessions.total}</div>
                  <div className="stat-sub">
                    {t.status.activeSessionsSub(status.activeSessions)}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">{t.status.outboundGateLabel}</div>
                  <div className="stat-value">
                    {status.telegramOutbound.inFlight} / {status.telegramOutbound.maxConcurrency}
                  </div>
                  <div className="stat-sub">
                    {t.status.outboundGateSub(
                      status.telegramOutbound.waiting,
                      status.telegramOutbound.retryQueueSize,
                      status.telegramOutbound.retryQueueMax
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>{t.status.capabilitiesSectionTitle}</span>
              </div>
              <div className="cap-list">
                {status.capabilities.map(
                  (capability: Readonly<MiniAppCapabilityStatus>): React.JSX.Element => (
                    <div key={capability.key} className="cap-block">
                      <div className="cap-header">
                        <span className="cap-title">{t.status.capabilityLabel(capability)}</span>
                        <span className={`badge ${capability.ready ? "ok" : "warn"}`}>
                          {capability.ready
                            ? t.status.capabilityReadyBadge
                            : t.status.capabilityMissingBadge}
                        </span>
                      </div>
                      <div className="cap-items">
                        {capability.items.length > 0
                          ? capability.items.map(
                            (
                              item: Readonly<MiniAppCapabilityDetailItem>,
                              idx: number
                            ): React.JSX.Element => {
                              const displayItem: Readonly<MiniAppCapabilityDetailItem> =
                                t.status.capabilityItem(item);
                              return (
                                <div key={`${item.label}-${idx}`} className="cap-item">
                                  <div className="cap-item-top">
                                    <span className="cap-tag">{displayItem.label}</span>
                                    {displayItem.sub !== undefined
                                      ? <span className="cap-sub">{displayItem.sub}</span>
                                      : null}
                                  </div>
                                  <div className="cap-val">{displayItem.value}</div>
                                </div>
                              );
                            }
                          )
                          : (
                            <div className="cap-item">
                              <div className="cap-val">{capability.detail}</div>
                            </div>
                          )}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          </>
        )
        : null}
    </section>
  );
}
