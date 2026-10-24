import { weatherCache } from "../../../cache/workers/aiChat/weather";
import { getTimeZone } from "../../../config/time";
import { GET_TOKYO_WEATHER_TOOL, unknownToolError } from "../../../consts/tools";
import { TOKYO_TIME_ZONE } from "../../../consts/time";
import { toolError } from "../utils/toolResult";
import type { TokyoWeatherResult } from "../../../types/aiChat/weather";

/**
 * 静态查询工具分发（声明清单见 consts/tools.ts 的 TOOL_DECLARATIONS）：无入参、无副作用，
 * 出错时返回错误 JSON。行动工具与群问答工具由 replyToolset/ 按轮组装。
 */

/**
 * 按名称执行静态查询；东京天气仅在启动时区为东京时可用，未挂载的名称返回未知工具错误。
 * @param name 静态查询工具名称。
 * @returns 查询结果或错误信息的 JSON 字符串。
 */
export function callTool(name: string): string {
  switch (name) {
    case GET_TOKYO_WEATHER_TOOL: {
      if (getTimeZone() !== TOKYO_TIME_ZONE) return toolError(unknownToolError(name));
      const result: TokyoWeatherResult | null = weatherCache.current;
      return JSON.stringify(result ?? { error: "Weather data not available yet" });
    }
    default:
      return toolError(unknownToolError(name));
  }
}
