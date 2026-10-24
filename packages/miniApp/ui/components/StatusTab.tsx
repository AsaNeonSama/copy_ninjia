import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { MINI_APP_STATUS_POLL_INTERVAL_MS } from "../../../consts/miniApp";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppStatusView,
} from "../../../types/miniApp";
import { fetchMiniAppStatus } from "../api";
import { formatBytes, formatTime, formatUptime } from "../formatters";

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
          onToast(`状态刷新失败: ${message}`);
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
    <section>
      <div className="toolbar">
        <span style={{ fontSize: "12px", color: "var(--hint)" }}>
          每 3 秒自动同步运行状态
        </span>
        <button
          type="button"
          className="btn"
          onClick={(): void => {
            void loadStatus(true);
          }}
        >
          立即刷新
        </button>
      </div>

      {loading && status === null
        ? <div className="card"><div className="empty">正在加载实时状态…</div></div>
        : null}

      {errorText !== null && status === null
        ? (
          <div className="card">
            <div className="empty" style={{ color: "var(--danger)" }}>
              鉴权或请求失败：{errorText}
            </div>
          </div>
        )
        : null}

      {status !== null
        ? (
          <>
            <div className="card">
              <div className="card-title">
                <span>进程与资源</span>
                <span className="badge">{formatTime(status.generatedAt)}</span>
              </div>
              <div className="grid-2">
                <div className="stat-box">
                  <div className="stat-label">运行时长</div>
                  <div className="stat-value">{formatUptime(status.uptimeMs)}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">平均 CPU 使用率</div>
                  <div className="stat-value">{status.cpuAveragePercent.toFixed(2)}%</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">当前 / 峰值 RSS</div>
                  <div className="stat-value">
                    {formatBytes(status.memoryCurrentRssBytes)} / {formatBytes(status.memoryPeakRssBytes)}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">JS 堆已用 / 总量</div>
                  <div className="stat-value">
                    {formatBytes(status.memoryHeapUsedBytes)} / {formatBytes(status.memoryHeapTotalBytes)}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>群状态、名单与活跃会话</span>
                <span className="badge ok">已 /init 群: {status.managedChatCount}</span>
              </div>
              <div className="grid-2">
                <div className="stat-box">
                  <div className="stat-label">白名单 / 黑名单总数</div>
                  <div className="stat-value">
                    {status.whitelistCount} / {status.blocklistCount}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">活跃会话总数</div>
                  <div className="stat-value">{status.activeSessions.total}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">入群验证 / /qa 表单</div>
                  <div className="stat-value">
                    {status.activeSessions.verify} / {status.activeSessions.qaSet}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">/gag 互动 / /wed 娶群友</div>
                  <div className="stat-value">
                    {status.activeSessions.gag} / {status.activeSessions.wed}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>Telegram 出站网关</span>
                <span className="badge">
                  在途: {status.telegramOutbound.inFlight} / {status.telegramOutbound.maxConcurrency}
                </span>
              </div>
              <div className="grid-2">
                <div className="stat-box">
                  <div className="stat-label">并发等待队列</div>
                  <div className="stat-value">{status.telegramOutbound.waiting}</div>
                </div>
                <div className="stat-box">
                  <div className="stat-label">重试队列占用</div>
                  <div className="stat-value">
                    {status.telegramOutbound.retryQueueSize} / {status.telegramOutbound.retryQueueMax}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <span>能力就绪与模型/任务配置</span>
              </div>
              <div className="cap-list">
                {status.capabilities.map(
                  (capability: Readonly<MiniAppCapabilityStatus>): React.JSX.Element => (
                    <div key={capability.key} className="cap-block">
                      <div className="cap-header">
                        <span className="cap-title">{capability.label}</span>
                        <span className={`badge ${capability.ready ? "ok" : "warn"}`}>
                          {capability.ready ? "已就绪" : "不可用"}
                        </span>
                      </div>
                      <div className="cap-items">
                        {capability.items.length > 0
                          ? capability.items.map(
                            (
                              item: Readonly<MiniAppCapabilityDetailItem>,
                              idx: number
                            ): React.JSX.Element => (
                              <div key={`${item.label}-${idx}`} className="cap-item">
                                <div className="cap-item-top">
                                  <span className="cap-tag">{item.label}</span>
                                  {item.sub !== undefined
                                    ? <span className="cap-sub">{item.sub}</span>
                                    : null}
                                </div>
                                <div className="cap-val">{item.value}</div>
                              </div>
                            )
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
