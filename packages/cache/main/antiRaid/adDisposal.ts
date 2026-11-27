/** owner: main。广告判定主线程处置（packages/antiRaid/adDetect.ts）的内存状态。 */

/** 通知 Anti-Raid Worker 释放指定群与发送者广告处置抑制标记的函数签名。 */
export type AdDetectDedupReleaser = (chatId: number, senderId: number) => void;

/**
 * 广告判定回投后在主线程运行的后台处置任务集合。
 *
 * 填充：antiRaid/adDetect.ts 的 handleAdDetected（按处罚设置执行删消息、全局封禁或本群处罚，以及
 * 自动拉黑贴纸/表情包持久化）及 handleAdVerdictTrue（临时广告免检累计清零）启动任务时加入。
 * 清理：每项任务结算时在 finally 中移除；停机由 drainAntiRaid 等待排空（见 docs/cn/04-invariants.md）。
 * 容量：等于同时在途的判定处置任务数，不设淘汰。进程重启后从空集开始。
 */
export const inFlightAdDisposals: Set<Promise<void>> = new Set<Promise<void>>();

/**
 * 广告处置抑制标记释放入口单槽位；由 `packages/antiRaid/workerBridge/controller.ts` 注入，
 * 主线程拒绝广告处置或完成非全局封禁处置时经它通知 Anti-Raid Worker 释放 `recentlyDisposedAdKeys`。
 * 运行期不淘汰、不清理，进程重启后从 null 开始，容量恒为单个槽位。
 */
export const adDetectDedupReleaserHolder: { current: AdDetectDedupReleaser | null } = {
  current: null,
};
