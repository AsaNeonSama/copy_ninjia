/** owner: main。头像更新队列状态（packages/copy/avatarQueue.ts）。 */

import type { AvatarUpdateTask } from "../../../types/copy/avatar";
import type { FlushWaiter } from "../../../types/lifecycle";

/** 全局头像更新单飞与最新待执行槽：入队时写入 pending 并递增代数，消费循环取出后清空 pending，全部完成时 running 归零；单例固定字段，进程重启后从初始值开始。 */
export const avatarUpdateState: {
  running: boolean;
  pending: AvatarUpdateTask | null;
  nextGeneration: number;
  latestGeneration: number;
} = {
  running: false,
  pending: null,
  nextGeneration: 1,
  latestGeneration: 0,
};

/** 头像更新排空等待集合（libs/drainWaiter.ts）：停机等待时登记，running 与 pending 归零或超时时结算移除；容量与并发停机调用方同阶，不淘汰，进程重启后从空集开始。 */
export const avatarDrainWaiters: Set<FlushWaiter> = new Set();
/** 头像更新准入开关与取消控制器：initAvatarUpdates 重建 controller 并开启准入，quiesceAvatarUpdates 关闭准入，排空超时时 abortAvatarUpdates 关闭准入并中止 controller；单例固定字段，进程重启后重新创建。 */
export const avatarUpdateRuntime: { accepting: boolean; controller: AbortController } = {
  accepting: true,
  controller: new AbortController(),
};
