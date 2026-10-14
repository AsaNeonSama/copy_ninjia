/** owner: main。全局与群状态权威存储内存状态（packages/infra/storage/stateStore.ts）。 */

import type { StateStore } from "../../infra/storage/statePersistence";
import type { TtsDailyUsage } from "../../types/aiChat/voiceMessage";
import type { GlobalCopyState } from "../../types/chatState";

/** 进程唯一 StateStore 实例 holder：首次经 infra/storage/stateStore.ts 访问时创建，停机时进入 quiesced 状态，进程重启后从 null 重新创建。 */
export const stateStoreHolder: { current: StateStore | null } = { current: null };

/**
 * 全局复读状态内存镜像：启动恢复时填充，adoptCopyTarget 写入目标三元组（copiedUser / copyMode / copyChatId），clearCopyTarget 清空目标；字段在初始化时固定且只原地赋值。
 * 单例固定字段，不淘汰；进程重启后从 memory/global/state.json 恢复。
 */
export const globalCopyState: GlobalCopyState = {
  lastCopyTime: undefined,
  copiedUser: null,
  copyMode: undefined,
  copyChatId: undefined,
};

/**
 * 全局 TTS 配额计数持久化镜像：
 * - 镜像语义：权威线程为 AI Worker（cache/workers/aiChat/ttsUsage.ts），每次配额变动后向主线程推送全量快照；主线程在 adoptTtsUsage 中整体替换本快照（两项计数皆归零时置为 null）并异步落盘，AI Worker 启动初始化后或崩溃重建时由 aiChat/workerBridge.ts 重放 hydrateTtsUsage；null 表示尚无配额使用记录。
 * - 填充与容量：启动恢复时从 memory/global/state.json 填充，运行期由回执整体覆盖；单例对象，不淘汰，进程重启后从磁盘恢复。
 */
export const globalTtsUsageState: { current: TtsDailyUsage | null } = { current: null };
