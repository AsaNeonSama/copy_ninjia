/**
 * 安装测试 Worker 的出站边界；先于真实 Worker 入口执行，只允许天气与 Gemini 显式缓存启动探测
 * （模型元数据、既有缓存列表，SDK 把路径拼在 base_url 之后）的罐头应答。
 */
import { WEATHER_API_URL } from "../../packages/consts/weather";

const GEMINI_MODEL_PATH: RegExp = /\/v1beta\/models\/[^/]+$/;
const GEMINI_CACHE_LIST_PATH: RegExp = /\/v1beta\/cachedContents$/;

console.log("INSTALL_WORKER_NETWORK_GUARD");
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  const url: URL = new URL(input instanceof Request ? input.url : String(input));
  if (GEMINI_MODEL_PATH.test(url.pathname)) {
    console.log("INSTALL_GEMINI_MODEL_PROBE");
    return Response.json({ supportedGenerationMethods: ["generateContent", "createCachedContent"] });
  }
  if (GEMINI_CACHE_LIST_PATH.test(url.pathname)) return Response.json({ cachedContents: [] });
  const allowed: URL = new URL(WEATHER_API_URL);
  if (url.origin !== allowed.origin || url.pathname !== allowed.pathname) {
    console.error("INSTALL_NETWORK_BLOCKED");
    throw new Error("Installation worker attempted an unexpected network request.");
  }
  console.log("INSTALL_WEATHER_MOCK");
  return Response.json({
    current: { temperature_2m: 20, weather_code: 0 },
    daily: { temperature_2m_max: [25], temperature_2m_min: [15], weather_code: [0] },
  });
}) as typeof fetch;
