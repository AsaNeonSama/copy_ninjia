/** owner: main。每聊天发送调度器运行态（packages/infra/telegram/sendScheduler.ts）。 */

import { TELEGRAM_SEND_GLOBAL_LIMIT } from "../../consts/telegram";
import { LinkedQueue } from "../../libs/linkedQueue";
import { TimestampDeque } from "../../libs/timestampDeque";
import type { TelegramSendChatKey, TelegramSendLane } from "../../types/telegramOutbound";

/**
 * 聊天键到发送车道的映射：首次向该聊天发送时创建，当车道无排队、无在途且分钟窗口、保守档与限流退避冻结均已结束时由车道定时器删除，出站生命周期全局取消或重新初始化时整表清空。
 * 容量与最近活跃或存在排队/冻结的聊天数同阶（全局排队总数上限为 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX），进程重启后从空表开始。
 */
export const sendChatLanes: Map<TelegramSendChatKey, TelegramSendLane> = new Map();

/** 全局发送秒级滑动窗口时间戳队列：每放行一条发送按消息条数写入时间戳，放行前淘汰滑出窗口的队首，出站生命周期重新初始化时清空；容量固定为 TELEGRAM_SEND_GLOBAL_LIMIT，进程重启后从空队列开始。 */
export const sendGlobalWindow: TimestampDeque = new TimestampDeque(TELEGRAM_SEND_GLOBAL_LIMIT);

/** 等待全局秒级窗口额度的发送车道轮转队列：车道仅缺全局额度时入队，全局定时器触发时按轮转顺序逐车道放行并出队，全局取消或重新初始化时清空；同一车道至多入队一次，容量不超过 sendChatLanes，进程重启后从空队列开始。 */
export const sendGlobalRing: LinkedQueue<TelegramSendLane> = new LinkedQueue<TelegramSendLane>();

/** 发送调度器全局排队总数（上限 TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX）与全局轮转定时器状态：任务入队/出队时增减，全局取消或重新初始化时归零；单例固定字段，进程重启后从初始值开始。 */
export const sendSchedulerState: {
  queuedTotal: number;
  globalTimer: ReturnType<typeof setTimeout> | null;
} = {
  queuedTotal: 0,
  globalTimer: null,
};
