/** owner: main。Google 翻译客户端、凭据快照与按群串行译文队列（packages/translate/）。 */

import type { v3 as GoogleTranslate } from "@google-cloud/translate";
import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { GoogleServiceAccountKey } from "../../types/config";
import type { TranslateMessageBacklog } from "../../types/translate";

/** Google 翻译服务账号凭据快照单例：启动预检解析成功后填充，运行期不清除、不淘汰；进程重启后从 null 重新加载。 */
export const googleServiceAccountKey: { current: GoogleServiceAccountKey | null } = { current: null };

interface TranslateRuntime {
  client: GoogleTranslate.TranslationServiceClient | null;
  accepting: boolean;
  generation: number;
  tasks: Set<Promise<unknown>>;
}

/** GCP project 路径前缀缓存单例：首次翻译请求时解析填充，closeTranslate 时清空为 null；进程重启后从 null 开始。 */
export const translateParentCache: { parent: string | null } = { parent: null };

/** 翻译运行时状态：initTranslate 开启 accepting，翻译请求与后台译文任务登记于 tasks 并在结算时移除，closeTranslate 关闭 client 并递增 generation；容量受并发请求与每群 TRANSLATE_CHAT_BACKLOG_MAX 约束，进程重启后从初始值开始。 */
export const translateRuntime: TranslateRuntime = {
  client: null,
  accepting: false,
  generation: 0,
  tasks: new Set(),
};

/** 群 ID 到后台译文串行任务链尾的映射：queueTranslateMessage 入队时写入，链排空时由执行器删除；容量与存在在途译文的受管群数同阶，不淘汰，进程重启后从空表开始。 */
export const translateMessageChains: Map<number, Promise<void>> = new Map();
/** 群 ID 到后台译文积压计数的映射：queueTranslateMessage 入队时递增、任务结算时递减并在归零时删除；单群上限为 TRANSLATE_CHAT_BACKLOG_MAX（满额跳过新消息），容量与 translateMessageChains 同阶，进程重启后从空表开始。 */
export const translateMessageBacklogs: Map<number, TranslateMessageBacklog> = new Map();
/** 绑定 translateMessageChains 的按群串行任务调度器单例。 */
export const translateMessageRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(translateMessageChains);
