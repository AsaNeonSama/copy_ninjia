/** owner: main。Anti-Raid 主线程代理（packages/antiRaid/workerBridge/）的内存状态。 */

import { ANTI_RAID_BARRIER_TIMEOUT_MS } from "../../../consts/antiRaid/protocol";
import { createFlushBarrier } from "../../../libs/flushBarrier";
import type { FlushBarrier } from "../../../libs/flushBarrier";

/**
 * Anti-Raid 主线程与 Worker 的 mailbox barrier。模块加载时创建，terminate
 * 时统一结算等待者；进程重启后以空等待表重建，容量受并发 flush 数约束。
 */
export const antiRaidBarrier: FlushBarrier = createFlushBarrier({
  timeoutMs: ANTI_RAID_BARRIER_TIMEOUT_MS,
});

/**
 * Anti-Raid 主线程代理的代际、初始化标记与镜像版本号。
 * Worker 重建时由 antiRaid/workerBridge/controller.ts 递增 generation；待验证镜像与
 * lockdown 记录变化时分别递增 verificationVersion 与 lockdownVersion，initAntiRaid 时归零。
 * 容量恒为一个对象，进程重启后从初值开始。
 */
export const antiRaidRuntimeState: {
  generation: number;
  initialized: boolean;
  verificationVersion: number;
  lockdownVersion: number;
} = {
  generation: 0,
  initialized: false,
  verificationVersion: 0,
  lockdownVersion: 0,
};

/**
 * 广告候选投递被 Worker 拒收的边沿日志标记。由收转拒时置 true 并记录错误，恢复投递或
 * initAntiRaid 时置 false。容量恒为一个布尔值，进程重启后从 false 开始。
 */
export const adCandidatePostRejected: { current: boolean } = { current: false };
