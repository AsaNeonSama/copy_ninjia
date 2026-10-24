/** Anti-Raid 待验证日文件的无状态 codec；不读取 Disk I/O Worker 缓存。 */

import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../consts/antiRaid/lockdown";
import {
  VERIFICATION_BASE_RECORD_KEYS,
  VERIFICATION_CHECKING_INVITER_RECORD_KEYS,
  VERIFICATION_EXPELLING_RECORD_KEYS,
  VERIFICATION_FILE_VERSION,
  VERIFICATION_KICK_PENDING_RECORD_KEYS,
  VERIFICATION_LABEL_MAX_CHARS,
} from "../../consts/diskIO/verification";
import { parseVerificationKey, verificationKey } from "../../libs/verificationKey";
import type { ParsedVerificationKey } from "../../libs/verificationKey";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  VerificationSnapshot,
  VerificationSnapshotBase,
} from "../../types/antiRaid/verification";

export type VerificationDayValue = VerificationSnapshot | null;

/**
 * 判断候选值是否为非负安全整数毫秒时间戳。
 * @param value 待校验的候选值。
 * @returns 非负安全整数时返回 true，否则返回 false。
 */
function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 判断候选值是否为正安全整数 ID 或序号。
 * @param value 待校验的候选值。
 * @returns 正安全整数时返回 true，否则返回 false。
 */
function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * 判断候选值是否为缺省或正安全整数 ID。
 * @param value 待校验的候选值。
 * @returns undefined 或正安全整数时返回 true，否则返回 false。
 */
function isOptionalPositiveId(value: unknown): value is number | undefined {
  return value === undefined || isPositiveId(value);
}

/**
 * 判断候选值是否为缺省或非负安全整数时间戳。
 * @param value 待校验的候选值。
 * @returns undefined 或非负安全整数时返回 true，否则返回 false。
 */
function isOptionalSafeTimestamp(value: unknown): value is number | undefined {
  return value === undefined || isSafeTimestamp(value);
}

/**
 * 按 phase 拒绝未知字段。
 * @param value 待校验的快照记录对象。
 * @returns 对象自有属性全部属于当前阶段允许字段集合时返回 true，否则返回 false。
 */
function hasCurrentVerificationKeys(value: Record<string, unknown>): boolean {
  let allowed: ReadonlySet<string> = VERIFICATION_BASE_RECORD_KEYS;
  if (value.phase === "kickPending") {
    allowed = VERIFICATION_KICK_PENDING_RECORD_KEYS;
  } else if (value.phase === "checkingInviter") {
    allowed = VERIFICATION_CHECKING_INVITER_RECORD_KEYS;
  } else if (value.phase === "expelling") {
    allowed = VERIFICATION_EXPELLING_RECORD_KEYS;
  }
  for (const key in value) {
    if (Object.hasOwn(value, key) && !allowed.has(key)) return false;
  }
  return true;
}

/**
 * 判断值是否为缺省或布尔真。
 * @param value 待校验的候选值。
 * @returns undefined 或 true 时返回 true，否则返回 false。
 */
function isOptionalTrue(value: unknown): value is true | undefined {
  return value === undefined || value === true;
}

/**
 * 校验各阶段共有字段与记录键，任一项非法返回 null。
 * @param key 顶层 JSON 对象中的 `<chatId>:<userId>` 记录键。
 * @param value 待校验的快照记录对象。
 * @returns 校验通过的公共快照字段；任一项非法时返回 null。
 */
function decodeVerificationBase(
  key: string,
  value: Record<string, unknown>
): VerificationSnapshotBase | null {
  if (
    value.version !== VERIFICATION_FILE_VERSION ||
    !isTelegramGroupChatId(value.chatId) ||
    !isPositiveId(value.userId) ||
    !isPositiveId(value.generation) ||
    !isPositiveId(value.revision) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > VERIFICATION_LABEL_MAX_CHARS ||
    typeof value.isBot !== "boolean" ||
    !Array.isArray(value.trackedMessageTimes) ||
    value.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT ||
    !value.trackedMessageTimes.every(isSafeTimestamp) ||
    !isOptionalPositiveId(value.announcementMessageId) ||
    !isOptionalPositiveId(value.invitedBy) ||
    !isOptionalPositiveId(value.reminderMessageId) ||
    !isOptionalPositiveId(value.replyReminderMessageId) ||
    typeof value.replyReminderRequested !== "boolean" ||
    !isOptionalPositiveId(value.welcomeAnchorMessageId) ||
    typeof value.reminderSuperseded !== "boolean" ||
    !isSafeTimestamp(value.joinedAt) ||
    !isSafeTimestamp(value.expiresAt) ||
    value.expiresAt < value.joinedAt ||
    key !== verificationKey(value.chatId, value.userId)
  ) return null;
  return {
    chatId: value.chatId,
    userId: value.userId,
    generation: value.generation,
    revision: value.revision,
    label: value.label,
    isBot: value.isBot,
    announcementMessageId: value.announcementMessageId,
    trackedMessageTimes: [...value.trackedMessageTimes],
    invitedBy: value.invitedBy,
    reminderMessageId: value.reminderMessageId,
    replyReminderMessageId: value.replyReminderMessageId,
    replyReminderRequested: value.replyReminderRequested,
    welcomeAnchorMessageId: value.welcomeAnchorMessageId,
    reminderSuperseded: value.reminderSuperseded,
    joinedAt: value.joinedAt,
    expiresAt: value.expiresAt,
  };
}

/**
 * 解码 kickPending 阶段快照并校验时间戳与提醒字段约束。
 * @param base 已校验的公共快照字段。
 * @param value 原始快照记录对象。
 * @returns `kickPending` 阶段快照；约束不满足时返回 null。
 */
function decodeKickPending(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const requestedAt: unknown = value.requestedAt;
  const countedJoinAt: unknown = value.countedJoinAt;
  if (
    !isSafeTimestamp(requestedAt) ||
    !isOptionalSafeTimestamp(countedJoinAt) ||
    base.joinedAt !== requestedAt ||
    base.expiresAt !== requestedAt ||
    base.reminderMessageId !== undefined ||
    base.replyReminderMessageId !== undefined
  ) return null;
  return { ...base, phase: "kickPending", requestedAt, countedJoinAt };
}

/**
 * 解码 checkingInviter 阶段快照。
 * @param base 已校验的公共快照字段。
 * @param value 原始快照记录对象。
 * @returns `checkingInviter` 阶段快照；`terminalInviterId` 非法时返回 null。
 */
function decodeCheckingInviter(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const terminalInviterId: unknown = value.terminalInviterId;
  if (!isPositiveId(terminalInviterId)) return null;
  return { ...base, phase: "checkingInviter", terminalInviterId };
}

/**
 * 解码 expelling 阶段快照。
 * @param base 已校验的公共快照字段。
 * @param value 原始快照记录对象。
 * @returns `expelling` 阶段快照；字段非法时返回 null。
 */
function decodeExpelling(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const expelReason: unknown = value.expelReason;
  const successNoticeSent: unknown = value.successNoticeSent;
  const failureNoticeSent: unknown = value.failureNoticeSent;
  const unconfirmedNoticeSent: unknown = value.unconfirmedNoticeSent;
  const removalConfirmed: unknown = value.removalConfirmed;
  if (
    (expelReason !== "timeout" && expelReason !== "flood") ||
    !isOptionalTrue(successNoticeSent) ||
    !isOptionalTrue(failureNoticeSent) ||
    !isOptionalTrue(unconfirmedNoticeSent) ||
    !isOptionalTrue(removalConfirmed)
  ) return null;
  return {
    ...base,
    phase: "expelling",
    expelReason,
    successNoticeSent,
    failureNoticeSent,
    unconfirmedNoticeSent,
    removalConfirmed,
  };
}

/**
 * 校验 pending 专属字段与当前阶段的一致性。
 * @param phase 记录声明的阶段值。
 * @param base 已校验的公共快照字段。
 * @returns 字段组合与阶段不变量一致时返回 true，否则返回 false。
 */
function hasConsistentPendingFacts(phase: unknown, base: VerificationSnapshotBase): boolean {
  const anchored: boolean = base.welcomeAnchorMessageId !== undefined;
  if (phase === "pending") return base.replyReminderRequested === anchored && base.reminderSuperseded === anchored;
  return base.trackedMessageTimes.length === 0 &&
    base.invitedBy === undefined &&
    !base.replyReminderRequested &&
    !anchored &&
    base.reminderSuperseded;
}

/**
 * 校验并解码单条待验证快照记录。
 * @param key 顶层 JSON 对象中的记录键。
 * @param value 待解码的记录原始值。
 * @returns 校验通过的待验证快照；非法时返回 null。
 */
function decodeVerificationSnapshot(
  key: string,
  value: unknown
): VerificationSnapshot | null {
  if (!isPlainRecord(value) || !hasCurrentVerificationKeys(value)) return null;
  const base: VerificationSnapshotBase | null = decodeVerificationBase(key, value);
  if (base === null || !hasConsistentPendingFacts(value.phase, base)) return null;
  switch (value.phase) {
    case "pending":
      return { ...base, phase: "pending" };
    case "kickPending":
      return decodeKickPending(base, value);
    case "checkingInviter":
      return decodeCheckingInviter(base, value);
    case "expelling":
      return decodeExpelling(base, value);
    default:
      return null;
  }
}

/**
 * 将内存快照转换为带 VERIFICATION_FILE_VERSION 的持久化对象。
 * @param snapshot 内存中的待验证快照。
 * @returns 附带当前文件版本号的可序列化记录对象。
 */
export function storedVerificationSnapshot(
  snapshot: VerificationSnapshot
): Record<string, unknown> {
  return { version: VERIFICATION_FILE_VERSION, ...snapshot };
}

/**
 * 校验墓碑记录键是否为合法的群与用户复合键。
 * @param key 待校验的顶层记录键。
 * @returns `<负群ID>:<正用户ID>` 规范键时返回 true，否则返回 false。
 */
function isVerificationTombstoneKey(key: string): boolean {
  const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
  return parsed !== null && isTelegramGroupChatId(parsed.chatId) && isPositiveId(parsed.userId);
}

/**
 * 严格解码完整日文件；任一 active 记录或墓碑键畸形时整份拒绝。
 * @param path 待验证日文件路径（用于构造错误消息）。
 * @param content 日文件的原始 UTF-8 文本。
 * @returns 记录键到最新快照或 null 墓碑的映射。
 */
export function decodeVerificationDay(
  path: string,
  content: string
): Map<string, VerificationDayValue> {
  const parsed: unknown = parseJsonInput(content, path);
  if (!isPlainRecord(parsed)) return invalidInput(path, "$", "a JSON object of verification records");

  const decoded: Map<string, VerificationDayValue> = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) {
      if (!isVerificationTombstoneKey(key)) {
        return invalidInput(path, "$.<record>", "a current verification record or null tombstone");
      }
      decoded.set(key, null);
      continue;
    }
    const snapshot: VerificationSnapshot | null =
      decodeVerificationSnapshot(key, value);
    if (snapshot === null) {
      return invalidInput(path, "$.<record>", "a current verification record or null tombstone");
    }
    decoded.set(key, snapshot);
  }
  return decoded;
}
