/** 一分钟的毫秒数，用作分钟级时长常量的换算单位。不变量：正整数毫秒数（`60_000`）。所属模块：`packages/mini-app-frontend/consts/miniApp.ts`。 */
export const MINUTE_MS: number = 60_000;

/** 一小时的毫秒数，用作小时级与天级时长常量的换算单位。不变量：正整数毫秒数（`3_600_000`）。所属模块：`packages/mini-app-frontend/consts/time.ts`。 */
export const HOUR_MS: number = 60 * MINUTE_MS;

/** 一天（24 小时）的毫秒数，用作多天缓存有效期等时长常量的换算单位。不变量：正整数毫秒数（`86_400_000`）。所属模块：`packages/mini-app-frontend/consts/miniApp.ts`。 */
export const DAY_MS: number = 24 * HOUR_MS;
