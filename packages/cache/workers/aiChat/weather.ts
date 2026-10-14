/** owner: workers/aiChat。东京天气缓存与定时刷新句柄（packages/aiChat/ai/weather.ts）。 */
import type { TokyoWeatherResult } from "../../../types/aiChat/weather";

/**
 * 最近一次成功拉取的东京天气结果（供 get_tokyo_weather 工具与心情系统只读，null 表示尚未完成首次成功刷新）。
 * 填充：aiChat/ai/weather.ts 刷新成功时写入（间隔 WEATHER_REFRESH_INTERVAL_MS）。
 * 清理：新结果覆盖或进程退出释放。
 * 重建：Worker 崩溃重启后从 null 开始，由刷新循环重新填充。
 * 容量：固定为单个 holder。
 */
export const weatherCache: { current: TokyoWeatherResult | null } = {
  current: null,
};

/**
 * 天气定时刷新 interval 句柄。
 * 填充：startWeatherRefreshLoop 启动时写入；清理：stopWeatherRefreshLoop 停止时清除；重建：Worker 重启后重新创建；容量：固定为单个 timer。
 */
export const weatherRefreshTimer: { current: ReturnType<typeof setInterval> | null } = { current: null };

/**
 * 天气刷新循环的取消控制器。
 * 填充：startWeatherRefreshLoop 启动时创建；清理：stopWeatherRefreshLoop 先置空再 abort；重建：Worker 重启后重新创建；容量：固定为单个 holder。
 */
export const weatherRefreshController: { current: AbortController | null } = { current: null };
