/** owner: main。群通知风格（packages/infra/atmosphere.ts）的主线程权威状态。 */

import type { Atmosphere } from "../../types/atmosphere";
/**
 * 本进程生效的群通知风格，容量为一个枚举值。
 * 填充：启动总闸（config/readiness.ts 的 ensurePromptFiles）结合 config/static/bot.json 与人设部署状态
 * 一次性写入（见 docs/cn/04-invariants.md）。运行期不热重载、不淘汰，进程重启后从 null 重建。
 * 业务 Worker 经初始化载荷接管副本，Worker 崩溃重建时由主线程重放；未填充时读取方拒绝使用。
 */
export const botAtmosphereState: { current: Atmosphere | null } = { current: null };
