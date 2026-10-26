import type { KeyboardButton, Message, SharedUser } from "grammy/types";
import {
  miniAppCompletedPickerResults,
  miniAppPendingPickers,
  miniAppPickerSequence,
} from "../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import {
  MINI_APP_PICKER_MAX_USERS_QUANTITY,
  MINI_APP_PICKER_TTL_MS,
} from "../consts/miniApp";
import { saveMiniAppPreparedKeyboardButton } from "../infra/telegram/actions/miniApp";
import type { MiniAppTelegramApi } from "../infra/telegram/actions/miniApp";
import type { TelegramIdentityMetadata } from "../types/identityPolicy";
import type {
  MiniAppIdentityMutationResult,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppPickerTargetList,
  MiniAppPreparedPickerSession,
} from "../types/miniApp";
import { setBlocklistEntryMembership } from "./view/identities/blocklist";
import { setWhitelistEntryMembership } from "./view/identities/whitelist";

/** `prepareMiniAppPicker` 的入参。 */
export interface PrepareMiniAppPickerParams {
  /** 选定后写入的目标名单（`"whitelist"` 或 `"blocklist"`）。 */
  readonly targetList: MiniAppPickerTargetList;
  /** 选择器目标类型（`"users"` 好友/联系人，或 `"channel"` 频道）。 */
  readonly subjectKind: MiniAppPickerSubjectKind;
  /** 可选的 Telegram API 替身（供测试注入）。 */
  readonly api?: Pick<MiniAppTelegramApi, "savePreparedKeyboardButton">;
}

/** `prepareMiniAppPicker` 的返回结果。 */
export type PrepareMiniAppPickerResult =
  | {
    readonly ok: true;
    readonly requestId: number;
    readonly preparedButtonId: string;
  }
  | {
    readonly ok: false;
    readonly message: string;
  };

/** 待导入的单个共享身份项。 */
interface SharedIdentityCandidate {
  /** 用户或频道 ID。 */
  readonly id: number;
  /** 随选择消息返回的展示资料。 */
  readonly meta: Readonly<TelegramIdentityMetadata>;
}

/**
 * 分配下一个 32 位正有符号整数 `request_id`（`1..0x7fffffff`）。
 * @returns 分配出的正整数请求 ID。
 */
function nextPickerRequestId(): number {
  const next: number = (miniAppPickerSequence.current % 0x7fffffff) + 1;
  miniAppPickerSequence.current = next;
  return next;
}

/**
 * 清理已超过 `MINI_APP_PICKER_TTL_MS` 的待处理选择器会话与已完成回执。
 * @param now 当前毫秒时间戳。
 */
export function pruneExpiredMiniAppPickers(now: number = Date.now()): void {
  for (const [requestId, session] of miniAppPendingPickers) {
    if (now - session.createdAt > MINI_APP_PICKER_TTL_MS) {
      miniAppPendingPickers.delete(requestId);
    }
  }
  for (const [requestId, result] of miniAppCompletedPickerResults) {
    if (now - result.completedAt > MINI_APP_PICKER_TTL_MS) {
      miniAppCompletedPickerResults.delete(requestId);
    }
  }
}

/**
 * 调用 Telegram Bot API `savePreparedKeyboardButton` 生成供 `Telegram.WebApp.requestChat` 使用的预存按钮 ID，并登记待消费会话。
 * @param params 目标名单、选择器身份种类及可选 API 替身。
 * @returns 成功时返回 `requestId` 与 `preparedButtonId`，失败时返回错误提示。
 */
export async function prepareMiniAppPicker({
  targetList,
  subjectKind,
  api,
}: PrepareMiniAppPickerParams): Promise<Readonly<PrepareMiniAppPickerResult>> {
  const now: number = Date.now();
  pruneExpiredMiniAppPickers(now);

  const requestId: number = nextPickerRequestId();
  const listLabel: string = targetList === "whitelist" ? "白名单" : "黑名单";
  const button: KeyboardButton.RequestUsersButton | KeyboardButton.RequestChatButton =
    subjectKind === "users"
      ? {
        text: `选择好友/联系人加入${listLabel}`,
        request_users: {
          request_id: requestId,
          user_is_bot: false,
          max_quantity: MINI_APP_PICKER_MAX_USERS_QUANTITY,
          request_name: true,
          request_username: true,
        },
      }
      : {
        text: `选择频道加入${listLabel}`,
        request_chat: {
          request_id: requestId,
          chat_is_channel: true,
          request_title: true,
          request_username: true,
        },
      };

  const preparedButtonId: string | undefined =
    await saveMiniAppPreparedKeyboardButton({
      userId: SUPER_ADMIN_USER_ID,
      button,
      api,
    });
  if (preparedButtonId === undefined || preparedButtonId.trim().length === 0) {
    return {
      ok: false,
      message: "无法创建 Telegram 原生选择器预备按钮，请确认 Bot API 支持 savePreparedKeyboardButton 或改用 ID 直接添加。",
    };
  }

  const session: Readonly<MiniAppPreparedPickerSession> = {
    requestId,
    preparedButtonId: preparedButtonId.trim(),
    targetList,
    subjectKind,
    createdAt: now,
  };
  miniAppPendingPickers.set(requestId, session);

  return {
    ok: true,
    requestId,
    preparedButtonId: session.preparedButtonId,
  };
}

/**
 * 查询指定 `requestId` 的原生选择器导入结果回执。
 * @param requestId 预备会话请求 ID。
 * @returns 已完成时返回结果回执，尚未完成或不存在时返回 `null`。
 */
export function getMiniAppPickerResult(
  requestId: number
): Readonly<MiniAppPickerResultEvent> | null {
  pruneExpiredMiniAppPickers();
  return miniAppCompletedPickerResults.get(requestId) ?? null;
}

/**
 * 将 `users_shared` 中的 `SharedUser` 转换为待导入身份项。
 * @param user Telegram 返回的共享用户资料。
 * @returns 待导入身份项。
 */
function candidateFromSharedUser(user: SharedUser): SharedIdentityCandidate {
  const firstName: string = user.first_name?.trim() ?? "";
  const lastName: string = user.last_name?.trim() ?? "";
  const username: string = user.username?.trim() ?? "";
  return {
    id: user.user_id,
    meta: {
      firstName: firstName.length > 0 ? firstName : `用户 ${user.user_id}`,
      lastName,
      username,
    },
  };
}

/**
 * 处理超级管理员私聊中由 `Telegram.WebApp.requestChat` 触发的 `users_shared` 或 `chat_shared` 服务消息，将所选好友/联系人或频道写入目标白名单或黑名单。
 * @param message Telegram 私聊服务消息。
 * @returns 命中待处理选择器会话并完成导入时返回结果事件，否则返回 `null`。
 */
export async function handleMiniAppSharedMessage(
  message: Message
): Promise<Readonly<MiniAppPickerResultEvent> | null> {
  if (message.chat.type !== "private") return null;
  if (message.chat.id !== SUPER_ADMIN_USER_ID || message.from?.id !== SUPER_ADMIN_USER_ID) {
    return null;
  }

  const now: number = Date.now();
  pruneExpiredMiniAppPickers(now);

  const requestId: number | undefined =
    message.users_shared?.request_id ?? message.chat_shared?.request_id;
  if (requestId === undefined) return null;

  const session: Readonly<MiniAppPreparedPickerSession> | undefined =
    miniAppPendingPickers.get(requestId);
  if (session === undefined) return null;

  const candidates: SharedIdentityCandidate[] = [];
  if (message.users_shared !== undefined && session.subjectKind === "users") {
    for (const sharedUser of message.users_shared.users) {
      if (Number.isSafeInteger(sharedUser.user_id) && sharedUser.user_id > 0) {
        candidates.push(candidateFromSharedUser(sharedUser));
      }
    }
  } else if (message.chat_shared !== undefined && session.subjectKind === "channel") {
    const chatId: number = message.chat_shared.chat_id;
    if (Number.isSafeInteger(chatId) && chatId < 0) {
      const title: string = message.chat_shared.title?.trim() ?? "";
      const username: string = message.chat_shared.username?.trim() ?? "";
      candidates.push({
        id: chatId,
        meta: {
          firstName: title.length > 0 ? title : `频道 ${chatId}`,
          lastName: "",
          username,
        },
      });
    }
  } else {
    return null;
  }

  miniAppPendingPickers.delete(requestId);

  const addedIds: number[] = [];
  const skippedIds: number[] = [];
  const duplicateIds: number[] = [];
  for (const candidate of candidates) {
    const mutation: Readonly<MiniAppIdentityMutationResult> =
      session.targetList === "whitelist"
        ? await setWhitelistEntryMembership({
          id: candidate.id,
          enabled: true,
          meta: candidate.meta,
        })
        : await setBlocklistEntryMembership({
          id: candidate.id,
          enabled: true,
          meta: candidate.meta,
        });
    if (mutation.ok && mutation.changed) {
      addedIds.push(candidate.id);
    } else if (mutation.duplicate === true || (mutation.ok && !mutation.changed)) {
      duplicateIds.push(candidate.id);
      skippedIds.push(candidate.id);
    } else {
      skippedIds.push(candidate.id);
    }
  }

  const listLabel: string = session.targetList === "whitelist" ? "白名单" : "黑名单";
  const duplicateSuffix: string =
    duplicateIds.length > 0 ? `，其中 ${duplicateIds.length} 个已在${listLabel}中（已去重拦截）` : "";
  const summary: string =
    addedIds.length > 0
      ? `哼，已帮杂鱼把 ${addedIds.length} 个身份加入${listLabel}${skippedIds.length > 0 ? `（跳过 ${skippedIds.length} 个${duplicateSuffix}）` : ""}♡`
      : duplicateIds.length > 0
        ? `笨蛋杂鱼♡，选中的 ${duplicateIds.length} 个目标早就已经在${listLabel}里啦，不许重复添加！`
        : `杂鱼♡，未能将所选身份加入${listLabel}（共跳过 ${skippedIds.length} 个）。`;

  const resultEvent: Readonly<MiniAppPickerResultEvent> = {
    requestId,
    targetList: session.targetList,
    completedAt: Date.now(),
    addedIds,
    skippedIds,
    duplicateIds,
    summary,
  };
  miniAppCompletedPickerResults.set(requestId, resultEvent);
  return resultEvent;
}

/**
 * 清空 Mini App 选择器的全部内存会话与回执状态（停机或测试重置时调用）。
 */
export function resetMiniAppPickerState(): void {
  miniAppPendingPickers.clear();
  miniAppCompletedPickerResults.clear();
  miniAppPickerSequence.current = 0;
}
