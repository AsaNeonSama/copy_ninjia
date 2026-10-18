import {
  hasPermanentWhitelistPermission,
  hasWhitelistPermission,
} from "../infra/identityPolicy/whitelist";
import { isAdminStatus } from "../libs/chatMember";
import type { ChatMember } from "grammy/types";
import type { AntiRaidMember } from "../types/antiRaid/protocol";

/**
 * 入群守卫主线程侧共用的成员事实：广告检测与防刷屏的白名单豁免读取
 * （canBypassAdDetection、canBypassFloodControl），以及从 grammY 的 User/ChatMember
 * 提取投递给 Worker 的身份字段与邀请者豁免资格（pickMember、isInviterExemptAdmin）。
 */

/** 广告检测专用豁免：只按当前有效权限的广告检测单项决定。 */
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

/** 防刷屏专用豁免：永久白名单按逐项权限决定，超级管理员恒持有该权限。 */
export function canBypassFloodControl(senderId: number): boolean {
  return hasPermanentWhitelistPermission(
    senderId,
    "isCanBypassFloodControl"
  );
}

export interface PickMemberParams {
  id: number;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
}

/** 从 grammY 的 User 对象里摘出投递给 Worker 的最小身份字段。 */
export function pickMember(user: PickMemberParams): AntiRaidMember {
  return { id: user.id, username: user.username, first_name: user.first_name, isBot: user.is_bot === true };
}

/**
 * 判定成员是否为具有邀请免验证资格的非匿名真人管理员（与 workers/antiRaid/adminCache.ts 的 fetchAdminIds 口径一致）。
 */
export function isInviterExemptAdmin(member: ChatMember): boolean {
  return isAdminStatus(member.status) &&
    member.user.is_bot !== true &&
    (!("is_anonymous" in member) || member.is_anonymous !== true);
}
