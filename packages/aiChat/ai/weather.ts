import { logger } from "../../infra/logger";
import {
  TOKYO_LATITUDE,
  TOKYO_LONGITUDE,
  WEATHER_API_URL,
  WEATHER_CODE_DESCRIPTIONS,
  WEATHER_REFRESH_INTERVAL_MS,
  WEATHER_REQUEST_TIMEOUT_MS,
} from "../../consts/weather";
import {
  weatherCache,
  weatherRefreshController,
  weatherRefreshTimer,
} from "../../cache/workers/aiChat/weather";
import { fetchJsonWithTimeout } from "../../infra/httpFetch";
import { isPlainRecord } from "../../libs/record";
import { TOKYO_TIME_ZONE } from "../../consts/time";

/**
 * 东京天气定时拉取与缓存更新（写入 weatherCache，供天气查询工具与心情系统读取）。
 */

/**
 * 将 WMO 天气代码转换为中文天气描述。
 * @param code WMO 天气代码。
 * @returns 对应的中文天气描述文本。
 */
function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `未知天气现象（代码 ${code}）`;
}

/**
 * 请求 WEATHER_API_URL 并更新 weatherCache；失败、超时、非当前世代或响应结构不符时保留原缓存。
 * @param controller 当前天气刷新世代的中止控制器。
 */
async function refreshTokyoWeather(controller: AbortController): Promise<void> {
  if (weatherRefreshController.current !== controller) return;
  const url: URL = new URL(WEATHER_API_URL);
  url.searchParams.set("latitude", String(TOKYO_LATITUDE));
  url.searchParams.set("longitude", String(TOKYO_LONGITUDE));
  url.searchParams.set("current", "temperature_2m,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", TOKYO_TIME_ZONE);

  const data: unknown = await fetchJsonWithTimeout({
    input: url,
    init: { signal: controller.signal },
    timeoutMs: WEATHER_REQUEST_TIMEOUT_MS,
    errorLabel: "Open-Meteo API",
  });
  if (data === null || weatherRefreshController.current !== controller) return;

  const record: Record<string, unknown> = isPlainRecord(data) ? data : {};
  const current: Record<string, unknown> = isPlainRecord(record.current)
    ? record.current
    : {};
  const daily: Record<string, unknown> = isPlainRecord(record.daily)
    ? record.daily
    : {};
  const first = (value: unknown): unknown => Array.isArray(value) ? value[0] : undefined;
  const currentTemperatureC: unknown = current.temperature_2m;
  const currentCode: unknown = current.weather_code;
  const todayMaxC: unknown = first(daily.temperature_2m_max);
  const todayMinC: unknown = first(daily.temperature_2m_min);
  const todayCode: unknown = first(daily.weather_code);

  if (
    typeof currentTemperatureC !== "number" ||
    typeof currentCode !== "number" ||
    typeof todayMaxC !== "number" ||
    typeof todayMinC !== "number" ||
    typeof todayCode !== "number"
  ) {
    logger.error("Open-Meteo API returned unexpected shape:", data);
    return;
  }

  weatherCache.current = {
    currentTemperatureC,
    currentCondition: describeWeatherCode(currentCode),
    todayMaxC,
    todayMinC,
    todayCondition: describeWeatherCode(todayCode),
  };
}

/**
 * 启动天气后台定时刷新循环（立即拉取一次并按 WEATHER_REFRESH_INTERVAL_MS 周期刷新）。
 */
export function startWeatherRefreshLoop(): void {
  if (weatherRefreshTimer.current !== null) return;
  const controller: AbortController = new AbortController();
  weatherRefreshController.current = controller;
  void refreshTokyoWeather(controller);
  weatherRefreshTimer.current = setInterval((): undefined => void refreshTokyoWeather(controller), WEATHER_REFRESH_INTERVAL_MS);
  weatherRefreshTimer.current.unref();
}

/** 停止天气定时刷新循环并中止在途请求。 */
export function stopWeatherRefreshLoop(): void {
  if (weatherRefreshTimer.current !== null) clearInterval(weatherRefreshTimer.current);
  weatherRefreshTimer.current = null;
  const controller: AbortController | null = weatherRefreshController.current;
  weatherRefreshController.current = null;
  controller?.abort();
}
