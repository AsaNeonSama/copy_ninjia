/** owner: perThread。Telegram 临时消息延迟删除的逐线程状态（packages/infra/telegram/actions/messageLifecycle.ts）。 */

import type { PendingMessageDeletion } from "../../types/telegram";

/** 尚未到期的延迟删除任务集合：消息发送成功后登记，定时器到期或停机提前兑现时移除；容量与延迟窗口内本线程发出的临时消息数同阶，线程重建后从空集开始。 */
export const pendingMessageDeletions: Set<PendingMessageDeletion> = new Set();

/** 已发起 Telegram 删除请求但尚未结算的任务集合：请求发出时登记，Promise 结算时自摘除；容量与并发兑现的删除请求数同阶，线程重建后从空集开始。 */
export const inFlightMessageDeletions: Set<Promise<void>> = new Set();
