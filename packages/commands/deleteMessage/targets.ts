/**
 * 追着删目标列表的纯函数增删规则，供 `/delete_message` 命令与 Mini App 群目标管理接口共用唯一实现。
 */

import { DELETE_MESSAGE_CHAT_TARGET_MAX } from "../../consts/deleteMessage";

/** 新增追着删目标的判定结果：成功时返回更新后的只读目标数组，拒绝时标明重复或超上限。 */
export type AddDeleteMessageTargetOutcome =
  | { readonly ok: true; readonly next: readonly number[] }
  | { readonly ok: false; readonly reason: "exists" | "capacity" };

/** 移除追着删目标的判定结果：成功时返回更新后的只读目标数组（空清单归一化为 `undefined`），不在册时返回 `absent`。 */
export type RemoveDeleteMessageTargetOutcome =
  | { readonly ok: true; readonly next: readonly number[] | undefined }
  | { readonly ok: false; readonly reason: "absent" };

/**
 * 在群追着删目标列表末尾追加一个唯一身份 ID，并执行重复判定与 `DELETE_MESSAGE_CHAT_TARGET_MAX` 容量上限校验。
 * @param current 群当前持久化的追着删目标列表；未配置时为 `undefined`。
 * @param targetId 待新增的目标用户或频道 ID。
 * @returns 校验通过时返回包含新增条目的新数组，否则返回 `"exists"` 或 `"capacity"` 拒绝原因。
 */
export function addDeleteMessageTargetId(
  current: readonly number[] | undefined,
  targetId: number
): AddDeleteMessageTargetOutcome {
  if (current !== undefined) {
    if (current.includes(targetId)) {
      return { ok: false, reason: "exists" };
    }
    if (current.length >= DELETE_MESSAGE_CHAT_TARGET_MAX) {
      return { ok: false, reason: "capacity" };
    }
    return { ok: true, next: [...current, targetId] };
  }
  return { ok: true, next: [targetId] };
}

/**
 * 从群追着删目标列表中移除指定身份 ID；目标原本不在册时返回 `absent`，移除后若列表为空则归一化为 `undefined`。
 * @param current 群当前持久化的追着删目标列表；未配置时为 `undefined`。
 * @param targetId 待撤销的目标用户或频道 ID。
 * @returns 移除成功时返回更新后的目标列表或 `undefined`，否则返回 `"absent"`。
 */
export function removeDeleteMessageTargetId(
  current: readonly number[] | undefined,
  targetId: number
): RemoveDeleteMessageTargetOutcome {
  if (current?.includes(targetId) !== true) {
    return { ok: false, reason: "absent" };
  }
  const remaining: readonly number[] = current.filter(
    (id: number): boolean => id !== targetId
  );
  return { ok: true, next: remaining.length === 0 ? undefined : remaining };
}
