import { botAtmosphereState } from "../cache/main/atmosphere";
import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import type { Atmosphere, AtmosphereTexts } from "../types/atmosphere";

/**
 * 主线程读取启动总闸确定的本进程通知风格；总闸完成前调用即为接线错误。
 * @returns 当前生效的机器人通知风格标识。
 */
export function botAtmosphere(): Atmosphere {
  const atmosphere: Atmosphere | null = botAtmosphereState.current;
  if (atmosphere === null) {
    throw new Error("Bot atmosphere was not initialized by the deployment input preflight.");
  }
  return atmosphere;
}

/**
 * 主线程群通知文案表；风格由启动总闸确定，配置优先级见 docs/cn/04-invariants.md。
 * @returns 当前生效风格对应的群通知文案表。
 */
export function chatAtmosphere(): AtmosphereTexts {
  return ATMOSPHERE_TEXTS[botAtmosphere()];
}
