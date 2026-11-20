/**
 * 入群守卫主线程侧共用的成员事实：广告检测与防刷屏的白名单/黑名单豁免读取
 * （canBypassAdDetection、readAdCandidateSenderStatus、isProtectedFromAdDisposal、
 * canBypassFloodControl），以及从 grammY 的 User/ChatMember 提取投递给 Worker
 * 的身份字段与邀请者豁免资格（pickMember、isInviterExemptAdmin）。
 */
import {
  getEffectiveWhitelistPermissions,
  hasPermanentWhitelistPermission,
  hasWhitelistPermission,
  readWhitelistPermissionOrBlocked,
} from "../infra/identityPolicy/whitelist";
import type { WhitelistPermissionOrBlocklistStatus } from
  "../infra/identityPolicy/whitelist";
import { isAdminStatus } from "../libs/chatMember";
import type { ChatMember } from "grammy/types";
import type { AntiRaidMember } from "../types/antiRaid/protocol";

/**
 * 广告检测专用豁免：只按当前有效权限的广告检测单项决定。
 *
 * @param senderId 发送者或频道的 Telegram ID
 * @param now 可选的当前毫秒时间戳
 * @returns 持有广告检测豁免权限时返回 true，否则返回 false
 */
export function canBypassAdDetection(
  senderId: number,
  now?: number
): boolean {
  return hasWhitelistPermission(
    senderId,
    "isCanBypassAdDetection",
    now
  );
}

/**
 * 广告候选构建阶段对发送者的单次身份策略读取：同一次缓存查找内先判定广告检测豁免，
 * 未豁免时再判定是否命中黑名单。
 *
 * @param senderId 发送者或频道的 Telegram ID
 * @param now 可选的当前毫秒时间戳
 * @returns 持有广告检测豁免返回 `"allowed"`，未豁免但命中黑名单返回 `"blocked"`，其余返回 `"none"`
 */
export function readAdCandidateSenderStatus(
  senderId: number,
  now?: number
): WhitelistPermissionOrBlocklistStatus {
  return readWhitelistPermissionOrBlocked(
    senderId,
    "isCanBypassAdDetection",
    now
  );
}

/**
 * 广告处置阶段判定发送者是否受保护（超级管理员、永久白名单成员或当前有效的临时广告免检）；
 * 经一次合并身份缓存读取完成判定。
 *
 * @param senderId 发送者或频道的 Telegram ID
 * @returns 发送者受保护、不得执行广告处罚时返回 true，否则返回 false
 */
export function isProtectedFromAdDisposal(senderId: number): boolean {
  return getEffectiveWhitelistPermissions(senderId) !== undefined;
}

/**
 * 防刷屏专用豁免：永久白名单按逐项权限决定，超级管理员恒持有该权限。
 *
 * @param senderId 发送者的 Telegram ID
 * @returns 持有防刷屏豁免权限时返回 true，否则返回 false
 */
export function canBypassFloodControl(senderId: number): boolean {
  return hasPermanentWhitelistPermission(
    senderId,
    "isCanBypassFloodControl"
  );
}

/** 提取投递给 Anti-Raid Worker 的成员身份所需的最小用户字段。 */
export interface PickMemberParams {
  /** 用户的 Telegram ID。 */
  id: number;
  /** 可选的 Telegram 用户名（不带 `@`）。 */
  username?: string;
  /** 可选的用户名字（first_name）。 */
  first_name?: string;
  /** 是否为机器人账号（缺省或为 `false` 时按真人处理）。 */
  is_bot?: boolean;
}

/**
 * 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。
 *
 * @param user grammY 的用户对象或最小成员身份字段
 * @returns 投递给 Anti-Raid Worker 的成员身份结构
 */
export function pickMember(user: PickMemberParams): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name, isBot: user.is_bot === true };
}

/**
 * 判定成员是否为具有邀请免验证资格的非匿名真人管理员（与 workers/antiRaid/adminCache.ts 的 fetchAdminIds 口径一致）。
 *
 * @param member Telegram 群成员状态对象
 * @returns 属于非匿名真人管理员时返回 true，否则返回 false
 */
export function isInviterExemptAdmin(member: ChatMember): boolean {
  return isAdminStatus(member.status) &&
    member.user.is_bot !== true &&
    (!("is_anonymous" in member) || member.is_anonymous !== true);
}
