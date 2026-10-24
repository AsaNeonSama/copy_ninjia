import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";

import { sendCommandMessage, unbanChatMemberIfBanned, unbanChatSenderChat } from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { resolveCommandTarget } from "./targetResolution";
import { rejectUnlessPermitted } from "./commandActor";
import { botCanRestrictMembersIn, resolveBotAdminStatus } from "../infra/botAdmin";
import {
  confirmBlocklistPersisted,
  managedAdminChatIds,
  runManagedChatBatch,
  unblockUser,
} from "../infra/blocklist/membership";
import type { ManagedChatOutcome } from "../infra/blocklist/membership";
import { runBlocklistFanOut } from "./blocklistFanOut";

/** 串行位内的名单解除结果。 */
interface UnblockListOutcome {
  /** 本次操作是否从黑名单中移除了该目标（目标此前处于黑名单中时为 `true`）。 */
  readonly removedFromList: boolean;
  /** 黑名单移除操作是否已收到 Disk I/O Worker 的落盘确认。 */
  readonly persisted: boolean;
}

/**
 * 先发布主线程 LRU 的解除结论，再投递 tombstone；后续入群更新立即读到新结论。随后等待
 * tombstone 的事务 ACK；名单里本就没有目标时，若上一次解除的 tombstone 尚未 ACK，先补投同一
 * 最终值再等待。名单里没有目标不代表各群没有封禁，跨群解封照常执行。
 * @param targetUser 被解除黑名单的目标身份。
 * @returns 名单移除结论与落盘确认状态。
 */
async function removeFromBlocklist(targetUser: CachedUser): Promise<UnblockListOutcome> {
  const removedFromList: boolean = unblockUser(targetUser.id);
  const persisted: boolean = await confirmBlocklistPersisted(targetUser.id, !removedFromList);
  return { removedFromList, persisted };
}

/**
 * `/block <目标> disable`：移除持久化黑名单身份，并解除已知管理群中的群级封禁。
 * 由 commands/block.ts 的 handleBlockCommand 按末位动作分派，只认 isCanUnBlock。
 *
 * 移出名单并等待持久化结果、跨群解封与回执都在该身份的黑名单串行位里依次执行：串行位
 * 空闲时名单解除在本条 update 内完成，跨群解封与回执交给延迟命令执行器的后台档，update
 * runner 不等各群的 Telegram 请求（见 ./blocklistFanOut.ts）。持久化失败仍继续解封，并在
 * 回执中附加警告。revision/ACK 与崩溃重放约束见 docs/cn/04-invariants.md。
 *
 * 目标支持回复、用户名、用户 id 或频道的负数 id；回复与参数同时存在时必须
 * 指向同一身份。裸 id 不要求命中缓存；`/block enable` 不接受裸负数 id。
 * @param ctx grammY 命令上下文。
 * @param targetArgument 去掉末位动作后的目标参数原文，可为空（此时只认回复目标）。
 */
export async function handleBlockDisable(ctx: CommandContext<Context>, targetArgument: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanUnBlock",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.unblockRejected(actorLabel)
  );
  if (actor === undefined) return;

  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    acceptChatId: true,
    // unblockUser 按名单结论决定是否写 tombstone，预热失败时拒绝执行。
    requireIdentityPolicies: true,
    // 拒绝当前群自己的身份，覆盖匿名管理员回复与裸会话 id；约束见 docs/cn/04-invariants.md。
    currentChatTargetText: chatAtmosphere().NOTICE_TEXTS.unblockCurrentChat,
    messages: chatAtmosphere().UNBLOCK_TARGET_TEXTS,
  });
  if (!targetUser) return;

  await runBlocklistFanOut({
    identityId: targetUser.id,
    command: "/block disable",
    prepare: (): Promise<UnblockListOutcome> => removeFromBlocklist(targetUser),
    fanOut: (listOutcome: UnblockListOutcome): Promise<void> => unbanEverywhereAndReport({
      chatId,
      messageId,
      targetUser,
      listOutcome,
    }),
  });
}

/** unbanEverywhereAndReport 的入参：handler 的校验结果与串行位内的名单解除结果。 */
interface UnbanEverywhereParams {
  /** 发起命令所在群聊 ID。 */
  readonly chatId: number;
  /** 发起命令的消息 ID；用于挂回复引用。 */
  readonly messageId: number | undefined;
  /** 被解封的目标身份。 */
  readonly targetUser: CachedUser;
  /** 串行位内的黑名单移除与落盘结果。 */
  readonly listOutcome: UnblockListOutcome;
}

/**
 * 跨群解封后在发起群回执名单结论与解封计数。
 * @param params 发起群上下文、被解封的目标身份与串行位内的黑名单移除结果。
 */
async function unbanEverywhereAndReport({
  chatId,
  messageId,
  targetUser,
  listOutcome,
}: UnbanEverywhereParams): Promise<void> {
  const { unbannedCount, failedCount }: UnbanOutcome = await unbanEverywhereFor(targetUser, chatId);
  // 该 id 的最终值（本次或上一次解除的 tombstone）未收到持久化确认时附加警告；没有未 ACK 最终值时不等待。
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
  const persistWarning: string = listOutcome.persisted
    ? ""
    : atmosphere.NOTICE_TEXTS.unblockPersistFailed;

  const listNote: string = listOutcome.removedFromList
    ? atmosphere.NOTICE_TEXTS.unblockRecorded(targetLabel, persistWarning)
    : atmosphere.NOTICE_TEXTS.unblockNotRecorded(targetLabel, persistWarning);

  if (unbannedCount === 0 && failedCount === 0) {
    const text: string = atmosphere.NOTICE_TEXTS.unblockNoManagedChat(listNote);
    await sendCommandMessage({ chatId, text, replyToMessageId: messageId });
    return;
  }
  const failedNote: string = failedCount > 0 ? atmosphere.NOTICE_TEXTS.unblockPartialFailure(failedCount) : "";
  const text: string = atmosphere.NOTICE_TEXTS.unblockResult(listNote, unbannedCount, failedNote);
  await sendCommandMessage({ chatId, text, replyToMessageId: messageId });
}

/** 跨受管管理员群执行解封的成功与失败群数统计。 */
interface UnbanOutcome {
  /** 成功调用解封接口的受管群数量。 */
  unbannedCount: number;
  /** 缺少封禁权限或解封请求失败的受管群数量。 */
  failedCount: number;
}

/**
 * 在机器人具有管理员身份的群中解除目标封禁。群清单与有界并发执行分别由
 * managedAdminChatIds、runManagedChatBatch 提供，结算结果按输入顺序计数。
 * @param targetUser 被解封的目标身份。
 * @param chatId 发起命令所在群聊 ID。
 * @returns 解封成功与失败的受管群计数。
 */
async function unbanEverywhereFor(targetUser: CachedUser, chatId: number): Promise<UnbanOutcome> {
  const isAdminHere: boolean = await resolveBotAdminStatus(chatId);
  const targetChatIds: number[] = managedAdminChatIds(chatId, isAdminHere);

  const outcomes: readonly ManagedChatOutcome<boolean>[] = await runManagedChatBatch<boolean>({
    chatIds: targetChatIds,
    action: `lift the ban on identity ${targetUser.id}`,
    onUnexpectedFailure: false,
    execute: (targetChatId: number): Promise<boolean> => {
      // 快照已确证缺「限制与封禁成员」的群不发请求，计为失败；快照未知时照常发，
      // 由 Telegram 裁决（与 /block enable 同口径，见 infra/botAdmin.ts 的 botCanRestrictMembersIn）。
      if (botCanRestrictMembersIn(targetChatId) === false) return Promise.resolve(false);
      // 频道身份解除 sender_chat 封禁；用户仅解除已有封禁，保留在群成员身份。
      return targetUser.isChannel === true
        ? unbanChatSenderChat(targetChatId, targetUser.id)
        : unbanChatMemberIfBanned(targetChatId, targetUser.id);
    },
  });

  let unbannedCount: number = 0;
  let failedCount: number = 0;
  for (const outcome of outcomes) {
    if (outcome.value) unbannedCount++;
    else failedCount++;
  }
  return { unbannedCount, failedCount };
}
