/**
 * Anti-Raid Worker 侧的群风格固定文案读取入口。
 */
import { atmosphereState } from "../../cache/workers/antiRaid/atmosphere";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../consts/bot";
import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import type { AtmosphereTexts } from "../../types/atmosphere";

/**
 * 读取主线程经 `agentConfig` 注入到本 Worker 的当前群风格文案表；尚未注入时回退默认风格。
 * @returns 当前群风格对应的固定文案表。
 */
export function workerAtmosphere(): AtmosphereTexts {
  return ATMOSPHERE_TEXTS[atmosphereState.current ?? BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]];
}
