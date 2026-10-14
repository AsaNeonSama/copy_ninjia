/** owner: main。广告判定主线程处置（packages/antiRaid/adDetect.ts）的内存状态。 */

/**
 * 广告判定回投后在主线程运行的后台处置任务集合。
 *
 * 填充：antiRaid/adDetect.ts 的 handleAdDetected（拉黑落盘与各受管群封禁）及
 * handleAdVerdictTrue（临时广告免检累计清零）启动任务时加入。
 * 清理：每项任务结算时在 finally 中移除；停机由 drainAntiRaid 等待排空（见 docs/cn/04-invariants.md）。
 * 容量：等于同时在途的判定处置任务数，不设淘汰。进程重启后从空集开始。
 */
export const inFlightAdDisposals: Set<Promise<void>> = new Set<Promise<void>>();
