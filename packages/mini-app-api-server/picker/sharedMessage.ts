import type { Message, SharedUser } from "grammy/types";
import { miniAppCompletedPickerResults, miniAppPendingPickers } from "../../cache/main/miniApp";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";
import type {
  MiniAppChatTargetsMutationResult,
  MiniAppIdentityMutationResult,
  MiniAppPickerResultEvent,
  MiniAppPreparedPickerSession,
} from "../../types/miniApp";
import { mutateManagedChatTargets } from "../view/chats/targets";
import { setBlocklistEntryMembership } from "../view/identities/blocklist";
import { cacheIdentityMetadataInBot } from "../view/identities/metadata";
import { setWhitelistEntryMembership } from "../view/identities/whitelist";
import { pruneExpiredMiniAppPickers } from "./sessions";

/** 待导入的单个共享身份项。 */
interface SharedIdentityCandidate {
  /** 用户或频道 ID。 */
  readonly id: number;
  /** 随选择消息返回的展示资料。 */
  readonly meta: Readonly<TelegramIdentityMetadata>;
}

/** 一批共享身份写入目标名单后的逐项归类。 */
interface PickerImportTally {
  /** 新加入目标名单的 ID。 */
  readonly addedIds: readonly number[];
  /** 未写入的 ID（含重复项）。 */
  readonly skippedIds: readonly number[];
  /** 因已在目标名单中而跳过的 ID。 */
  readonly duplicateIds: readonly number[];
  /** 首个非重复跳过项的服务端回执码（供全部失败时透传具体原因，如 `IDENTITY_IN_WHITELIST`、`TARGET_NOT_IN_CHAT`）。 */
  readonly firstFailureMessage?: string;
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
 * 按会话的身份种类从服务消息中取出待导入身份：好友/联系人只收正整数用户 ID，频道只收负数会话 ID。
 * @param message Telegram 私聊服务消息。
 * @param session 与消息 `request_id` 对应的待处理选择器会话。
 * @returns 待导入身份列表；消息携带的共享种类与会话不符时返回 `null`。
 */
function collectSharedCandidates(
  message: Message,
  session: Readonly<MiniAppPreparedPickerSession>
): SharedIdentityCandidate[] | null {
  if (message.users_shared !== undefined && session.subjectKind === "users") {
    const candidates: SharedIdentityCandidate[] = [];
    for (const sharedUser of message.users_shared.users) {
      if (Number.isSafeInteger(sharedUser.user_id) && sharedUser.user_id > 0) {
        candidates.push(candidateFromSharedUser(sharedUser));
      }
    }
    return candidates;
  }
  if (message.chat_shared !== undefined && session.subjectKind === "channel") {
    const chatId: number = message.chat_shared.chat_id;
    if (!Number.isSafeInteger(chatId) || chatId >= 0) return [];
    const title: string = message.chat_shared.title?.trim() ?? "";
    const username: string = message.chat_shared.username?.trim() ?? "";
    return [{
      id: chatId,
      meta: {
        firstName: title.length > 0 ? title : `频道 ${chatId}`,
        lastName: "",
        username,
      },
    }];
  }
  return null;
}

/**
 * 逐个将共享身份加入目标名单，并按新加入、重复与其余跳过归类。
 * @param session 待消费的选择器会话。
 * @param candidates 待导入身份列表。
 * @returns 逐项归类结果。
 */
async function importSharedCandidates(
  session: Readonly<MiniAppPreparedPickerSession>,
  candidates: readonly SharedIdentityCandidate[]
): Promise<PickerImportTally> {
  const addedIds: number[] = [];
  const skippedIds: number[] = [];
  const duplicateIds: number[] = [];
  let firstFailureMessage: string | undefined;
  const { targetList, chatId, language }: Readonly<MiniAppPreparedPickerSession> = session;

  if (targetList === "deleteMessage" || targetList === "translate") {
    if (chatId === undefined) {
      for (const candidate of candidates) {
        skippedIds.push(candidate.id);
      }
      return { addedIds, skippedIds, duplicateIds };
    }
    for (const candidate of candidates) {
      cacheIdentityMetadataInBot(candidate.id, candidate.meta);
      const mutation: Readonly<MiniAppChatTargetsMutationResult> =
        targetList === "deleteMessage"
          ? await mutateManagedChatTargets(chatId, {
            action: "addDeleteTarget",
            target: String(candidate.id),
          })
          : await mutateManagedChatTargets(chatId, {
            action: "addTranslateTarget",
            target: String(candidate.id),
            language: language ?? "ja",
          });
      if (
        mutation.ok &&
        (mutation.message === "DELETE_TARGET_ADDED" ||
          mutation.message === "TRANSLATE_TARGET_ADDED" ||
          mutation.message === "TRANSLATE_TARGET_UPDATED")
      ) {
        addedIds.push(candidate.id);
      } else if (
        mutation.message === "DELETE_TARGET_ALREADY_EXISTS" ||
        mutation.message === "TRANSLATE_TARGET_ALREADY_EXISTS"
      ) {
        duplicateIds.push(candidate.id);
        skippedIds.push(candidate.id);
      } else {
        firstFailureMessage ??= mutation.message;
        skippedIds.push(candidate.id);
      }
    }
    return {
      addedIds,
      skippedIds,
      duplicateIds,
      ...(firstFailureMessage !== undefined ? { firstFailureMessage } : {}),
    };
  }

  for (const candidate of candidates) {
    cacheIdentityMetadataInBot(candidate.id, candidate.meta);
    const mutation: Readonly<MiniAppIdentityMutationResult> =
      targetList === "whitelist"
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
      firstFailureMessage ??= mutation.message;
      skippedIds.push(candidate.id);
    }
  }
  return {
    addedIds,
    skippedIds,
    duplicateIds,
    ...(firstFailureMessage !== undefined ? { firstFailureMessage } : {}),
  };
}

/**
 * 生成导入结果回执的英文状态码：有新加入时返回 `"PICKER_IMPORT_ADDED"`，未新加入但存在非重复失败原因时透传首个失败状态码，全部重复时返回 `"PICKER_IMPORT_DUPLICATE"`，其余返回 `"PICKER_IMPORT_EMPTY"`。
 * @param tally 逐项归类结果。
 * @returns 英文状态码字串。
 */
function formatPickerImportSummary(
  tally: Readonly<PickerImportTally>
): string {
  const { addedIds, duplicateIds, firstFailureMessage }: Readonly<PickerImportTally> = tally;
  return addedIds.length > 0
    ? "PICKER_IMPORT_ADDED"
    : firstFailureMessage ??
      (duplicateIds.length > 0 ? "PICKER_IMPORT_DUPLICATE" : "PICKER_IMPORT_EMPTY");
}

/**
 * 处理超级管理员私聊中由 `Telegram.WebApp.requestChat` 触发的 `users_shared` 或 `chat_shared` 服务消息：
 * 核对待处理会话后消费该会话，将所选好友/联系人或频道写入目标白名单、黑名单、删发言目标或翻译目标，并登记结果回执供前端轮询。
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

  pruneExpiredMiniAppPickers();

  const requestId: number | undefined =
    message.users_shared?.request_id ?? message.chat_shared?.request_id;
  if (requestId === undefined) return null;

  const session: Readonly<MiniAppPreparedPickerSession> | undefined =
    miniAppPendingPickers.get(requestId);
  if (session === undefined) return null;

  const candidates: SharedIdentityCandidate[] | null = collectSharedCandidates(message, session);
  if (candidates === null) return null;
  miniAppPendingPickers.delete(requestId);

  const tally: PickerImportTally = await importSharedCandidates(session, candidates);
  const resultEvent: Readonly<MiniAppPickerResultEvent> = {
    requestId,
    targetList: session.targetList,
    completedAt: Date.now(),
    addedIds: tally.addedIds,
    skippedIds: tally.skippedIds,
    duplicateIds: tally.duplicateIds,
    summary: formatPickerImportSummary(tally),
  };
  miniAppCompletedPickerResults.set(requestId, resultEvent);
  return resultEvent;
}
