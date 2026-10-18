/** owner: workers/antiRaid。黑名单补扫处置世代与在途计数（packages/workers/antiRaid/blocklistEffects.ts）。 */

/**
 * chatId -> 黑名单补扫处置世代号。
 * 填充：群停管（deactivateChat）且存在在途补扫任务时经 bumpBlocklistRemovalEpoch 递增写入。
 * 清理：该群在途任务数归零时删除，Worker 停止时清空。
 * 重建：Worker 崩溃重启后从空表开始，未完成批次由主线程重投并从零世代重新比对。
 * 容量：不超过存在在途黑名单处置任务的群数，不设淘汰。
 */
export const blocklistRemovalEpochs: Map<number, number> = new Map();

/**
 * chatId -> 正在执行的黑名单处置任务数。
 * 填充：任务启动时递增；清理：任务结算时递减并在归零时连同 blocklistRemovalEpochs 删键；重建：Worker 重启后为空；容量：受在途处置群数约束。
 */
export const blocklistRemovalTaskCounts: Map<number, number> = new Map();

/** 群停管时递增该群的黑名单处置世代号（无在途任务时直接删键），使在途补扫批次放弃后续操作。 */
export function bumpBlocklistRemovalEpoch(chatId: number): void {
  if ((blocklistRemovalTaskCounts.get(chatId) ?? 0) === 0) {
    blocklistRemovalEpochs.delete(chatId);
    return;
  }
  blocklistRemovalEpochs.set(chatId, (blocklistRemovalEpochs.get(chatId) ?? 0) + 1);
}

/** 读取指定群当前的黑名单处置世代号；无条目时返回零。 */
export function currentBlocklistRemovalEpoch(chatId: number): number {
  return blocklistRemovalEpochs.get(chatId) ?? 0;
}
