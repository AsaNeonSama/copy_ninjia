/**
 * 广告命中处罚动作的类型（判定见 packages/states/adPunishment.ts，全局封禁的执行见
 * packages/antiRaid/adDetect.ts，本群处罚的执行见 packages/antiRaid/adPunishment.ts）。
 */

import type { AdMutePunishment } from "../config";

/** 本群处罚动作：只作用于触发群，不写永久黑名单，也不进 durable outbox。 */
export type AdInChatPunishmentAction =
  /** 在触发群禁言，直接沿用 ad_detect.json 的禁言设置。 */
  | AdMutePunishment
  /** 只踢不封：移出触发群，可再次入群。 */
  | Readonly<{ kind: "kick" }>
  /** 只在触发群以 banChatMember 封禁并撤回历史消息。 */
  | Readonly<{ kind: "banChat" }>
  /** 频道身份无法禁言或移出：除 Worker 已删除的消息外不另行处罚。 */
  | Readonly<{ kind: "deleteOnly" }>;

/** 一次广告命中在主线程落定的处罚动作。 */
export type AdPunishmentAction =
  | AdInChatPunishmentAction
  /** 写入永久黑名单，并经 durable outbox 在全部受管群封禁。 */
  | Readonly<{ kind: "blockGlobal" }>;
