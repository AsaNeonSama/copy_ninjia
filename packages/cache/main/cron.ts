/** owner: main。定时任务配置与调度器运行时状态（packages/config/cron.ts、packages/cron/scheduler.ts）。 */

import type { CronConfig, CronRuntime } from "../../types/cron";

/**
 * cron.json 已生效配置快照单例：启动预检在文件存在时填充，热重载时整体替换（文件删除时置 null）；容量上限为 CRON_MAX_TASKS 与 CRON_MAX_ACTIONS_PER_TASK，不淘汰，进程重启后从 null 重新填充。
 */
export const cronConfigCache: { current: CronConfig | null } = { current: null };

/**
 * cron 调度器运行时单例：startCronScheduler 创建并按任务表登记调度，热重载按任务名增量对账（未变保留、变更或删除停止并移除、新增登记），在途轮次登记于 runs 并在结算时移除；just_once 执行记录存于容量上限为 CRON_JUST_ONCE_RECORD_MAX 的 LRU。
 * 停机时先 quiesce 停止全部句柄，再在预算内排空或超时中止 runs 并置 null；调度数上限为 CRON_MAX_TASKS，进程重启后从 null 重新创建。
 */
export const cronRuntime: { current: CronRuntime | null } = { current: null };
