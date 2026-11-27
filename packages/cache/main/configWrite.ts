/** owner: main。部署配置文件（config/dynamic/ 与 config/static/）写入的单链串行尾节点句柄，由 Mini App 配置保存持有。 */

import type { SerialChainHolder } from "../../libs/serialChain";

/**
 * 部署配置文件写入（Mini App 配置保存）的进程内单链串行尾节点句柄
 * （经 `libs/serialChain.ts` 的 `runSerialChain` 读写），消除并发修改与跨文件校验的 TOCTOU 竞态。
 * - 填充：每次提交部署配置写盘任务时把 `current` 推进到本次校验与原子写盘吸收结果与异常后的链尾。
 * - 清理：链尾随本次任务结算自然兑现，句柄只保留当前尾节点（停机后不再入队，已在途项自行结束）。
 * - 容量与重建：恒为单个尾节点 Promise（无队列蓄积溢出风险）；与 Worker 崩溃无关，进程重启后从已兑现的空 Promise 开始，不设额外淘汰策略。
 */
export const deploymentConfigWriteChainHolder: SerialChainHolder = {
  current: Promise.resolve(),
};
