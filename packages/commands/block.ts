import type { AtmosphereTexts } from "../types/atmosphere";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type { ToggleAction } from "../types/commands";
import { replyCommandNotice, sendCommandMessage } from "../infra/telegram";
import { formatTargetLabel } from "../users/userLabel";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";

import { resolveCommandTarget } from "./targetResolution";
import { parseToggleAction, splitTrailingToken } from "./arguments";
import type { TrailingTokenSplit } from "./arguments";
import { handleBlockDisable } from "./unblock";
import { rejectUnlessPermitted } from "./commandActor";
import { botChatPermissionsIn } from "../infra/botAdmin";
import { describeBotPermissionGap } from "../libs/botPermissionGap";
import type { BotChatPermissions } from "../types/telegram";
import { runProtectedIdentityMutation } from "../infra/identityPolicy/coordination";
import {
  identityMetadataFromCachedUser,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
} from "../infra/identityStorage";
import {
  blockUser,
  confirmBlocklistPersisted,
  managedAdminChatIds,
} from "../infra/blocklist/membership";
import { banBlockedIdentityInManagedChats } from "../infra/blocklist/crossChatBan";
import { runBlocklistFanOut } from "./blocklistFanOut";

/** 串行位内的名单写入结果：缓存重预热失败或受保护目标不写名单。 */
type BlockAdmission =
  | {
    /** 身份策略重预热失败，拒绝执行本次拉黑。 */
    readonly status: "unavailable";
  }
  | {
    /** 目标处于白名单保护范围内，拒绝拉黑。 */
    readonly status: "protected";
  }
  | {
    /** 目标未受白名单保护，已执行黑名单写入与落盘确认。 */
    readonly status: "admitted";
    /** 目标是否为本次新写入黑名单（已在黑名单中时为 false）。 */
    readonly newlyBlocked: boolean;
    /** 黑名单写入是否已收到 Disk I/O Worker 的落盘确认。 */
    readonly persisted: boolean;
  };

/**
 * `/block <目标> enable`：将目标写入永久黑名单，并在所有受管管理员群同步执行封禁。
 *
 * - **跨群封禁范围**：受管群清单取自 `infra/blocklist/membership.ts` 的 `managedAdminChatIds`
 *   （按各群 `ChatState.botPermissions.isAdministrator` 筛选）。每群直接发起一次封禁请求（不预先探测是否在群）；
 *   权限快照已确证缺少「限制与封禁成员」的群直接计入失败。若机器人在发起群不是管理员，其它受管群照常封禁并在回执中注明本群跳过；
 *   无受管群时仅回执名单写入结果（`blockNoManagedChat`）。
 * - **同身份串行与后台扇出**：名单写入与落盘确认、跨群封禁及战报均在该身份的黑名单串行位内按序执行。
 *   串行位空闲时名单写入在当前 update 内完成，跨群封禁与战报交由延迟命令执行器后台档运行（见 `./blocklistFanOut.ts`）。
 * - **持久化与入群秒踢**：黑名单先于跨群封禁写入（与封禁成败无关），由 Disk I/O Worker 持久化至
 *   `database/storage.sqlite`（见 `infra/identityStorage.ts`）；此后目标出现在任何监听群的入群事件中均会被秒踢
 *   （见 `antiRaid/blocklistGuard.ts`）。
 * - **目标解析与权限**：仅持有 `isCanBlock` 的身份可用；目标支持回复消息、身份缓存中的 `@username` 或正整数裸用户 ID
 *   （频道目标须经回复或用户名解析，随后调用 `banChatSenderChat` 封禁该频道身份）。权限与受保护目标边界见 `docs/cn/04-invariants.md`。
 *
 * @param ctx grammY 命令上下文。
 * @param targetArgument 去掉末位动作后的目标参数原文，可为空（此时只认回复目标）。
 */
async function blockTarget(ctx: CommandContext<Context>, targetArgument: string): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanBlock",
    (actorLabel: string, atmosphere: AtmosphereTexts): string => atmosphere.NOTICE_TEXTS.blockRejected(actorLabel)
  );
  if (actor === undefined) return;

  // 保留整份权限快照：本群没封时，回执据它说明原因（见 describeBotPermissionGap）。
  const herePermissions: BotChatPermissions | undefined = await botChatPermissionsIn(chatId);
  const isAdminHere: boolean = herePermissions?.isAdministrator === true;

  // 目标解析与 /copy 共用冲突校验；额外接受裸用户 id。
  const targetUser: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    // 白名单保护检查与 blockUser 均读取目标的名单结论，预热失败时拒绝执行。
    requireIdentityPolicies: true,
    // 拒绝目标为当前群自己的 identity（匿名管理员群身份）：Telegram 只提供
    // sender_chat=当前群，不暴露真实用户，封禁只会落在群组身份上。
    currentChatTargetText: chatAtmosphere().NOTICE_TEXTS.blockCurrentChat,
    messages: chatAtmosphere().BLOCK_TARGET_TEXTS,
  });
  if (!targetUser) return;

  await runBlocklistFanOut({
    identityId: targetUser.id,
    command: "/block enable",
    prepare: (): Promise<BlockAdmission> => admitBlockTarget(targetUser),
    fanOut: (admission: BlockAdmission): Promise<void> => reportBlockAdmission({
      chatId,
      messageId,
      targetUser,
      herePermissions,
      isAdminHere,
      admission,
    }),
  });
}

/**
 * 白名单保护检查与名单写入处于同一身份事务边界，若等待互斥锁期间缓存被挤出则先重预热；
 * 预热失败或受保护目标不进入封禁流程。黑名单先写、与封禁结果无关：先发布 LRU 最终值，
 * 再把 revision 投给 DiskIO Worker；重复 /block 同一个人时 blockUser 返回 false，不创建新 revision。
 * 随后等待该 id 最新 revision 的事务 ACK；重复 /block 时若最新 revision 尚未 ACK，先把同一最终值
 * 重投给当前 Worker（不创建新 revision）再等待。
 * @param targetUser 待拉黑的目标身份。
 * @returns 名单准入结论（不可用、受保护，或是否本次新写入以及是否已确认落盘）。
 */
async function admitBlockTarget(targetUser: CachedUser): Promise<BlockAdmission> {
  // isWhitelisted 已经把超级管理员算进白名单边界（infra/identityPolicy/whitelist.ts）；受保护时返回 "protected"。
  const outcome: "unavailable" | "protected" | boolean = await runProtectedIdentityMutation(
    async (): Promise<"unavailable" | "protected" | boolean> => {
      if (!isIdentityPolicyCached(targetUser.id) && !await prefetchIdentityPolicies([targetUser.id])) {
        return "unavailable";
      }
      if (isWhitelisted(targetUser.id)) return "protected";
      return blockUser(targetUser.id, identityMetadataFromCachedUser(targetUser));
    }
  );
  if (outcome === "unavailable") return { status: "unavailable" };
  if (outcome === "protected") return { status: "protected" };
  const persisted: boolean = await confirmBlocklistPersisted(targetUser.id, !outcome);
  return { status: "admitted", newlyBlocked: outcome, persisted };
}

/** reportBlockAdmission 的入参：handler 的校验结果与串行位内的名单写入结果。 */
interface ReportBlockAdmissionParams {
  /** 发起命令所在群聊 ID。 */
  readonly chatId: number;
  /** 发起命令的消息 ID；用于挂回复引用。 */
  readonly messageId: number | undefined;
  /** 被拉黑的目标身份。 */
  readonly targetUser: CachedUser;
  /** 机器人在发起群的管理员权限快照；未知时为 undefined。 */
  readonly herePermissions: BotChatPermissions | undefined;
  /** 机器人在发起群是否具有管理员身份。 */
  readonly isAdminHere: boolean;
  /** 串行位内的黑名单准入与落盘结果。 */
  readonly admission: BlockAdmission;
}

/**
 * 受保护目标与无受管群时直接回执；否则跨群封禁并发战报。
 * @param params 发起群上下文、目标身份、机器人在本群的管理员权限快照与黑名单准入结果。
 */
async function reportBlockAdmission({
  chatId,
  messageId,
  targetUser,
  herePermissions,
  isAdminHere,
  admission,
}: ReportBlockAdmissionParams): Promise<void> {
  if (admission.status === "unavailable") {
    await sendCommandMessage({
      chatId,
      text: chatAtmosphere().IDENTITY_POLICY_UNAVAILABLE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }
  if (admission.status === "protected") {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    const text: string = atmosphere.NOTICE_TEXTS.blockProtected(formatTargetLabel(targetUser, atmosphere));
    await sendCommandMessage({ chatId, text, replyToMessageId: messageId });
    return;
  }

  // 封禁清单与 /block disable 的跨群解封同源，见 infra/blocklist/membership.ts 的 managedAdminChatIds。
  const targetChatIds: number[] = managedAdminChatIds(chatId, isAdminHere);

  // 无跨群操作时直接渲染本次落盘结果。
  if (targetChatIds.length === 0) {
    const atmosphere: AtmosphereTexts = chatAtmosphere();
    const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
    const persistWarning: string = admission.persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
    const text: string = atmosphere.NOTICE_TEXTS.blockNoManagedChat(targetLabel, persistWarning);
    await sendCommandMessage({ chatId, text, replyToMessageId: messageId });
    return;
  }

  await banEverywhereAndReport({
    chatId,
    messageId,
    targetUser,
    targetChatIds,
    herePermissions,
    isAdminHere,
    newlyBlocked: admission.newlyBlocked,
    persisted: admission.persisted,
  });
}

/** banEverywhereAndReport 的入参：handler 已完成校验与名单落盘后的全部事实。 */
interface BanEverywhereParams {
  /** 发起命令所在群聊 ID。 */
  readonly chatId: number;
  /** 发起命令的消息 ID；用于挂回复引用。 */
  readonly messageId: number | undefined;
  /** 被拉黑的目标身份。 */
  readonly targetUser: CachedUser;
  /** 需要执行封禁的受管管理员群 ID 清单。 */
  readonly targetChatIds: readonly number[];
  /** 机器人在发起群的管理员权限快照；未知时为 undefined。 */
  readonly herePermissions: BotChatPermissions | undefined;
  /** 机器人在发起群是否具有管理员身份。 */
  readonly isAdminHere: boolean;
  /** 目标是否为本次新加入黑名单。 */
  readonly newlyBlocked: boolean;
  /** 黑名单写入是否已收到落盘确认。 */
  readonly persisted: boolean;
}

/**
 * 在全部受管群封禁目标，失败群重新欠一次补扫，最后在发起群发战报。
 * @param params 发起群上下文、目标身份、受管群清单及黑名单写入与落盘状态。
 */
async function banEverywhereAndReport({
  chatId,
  messageId,
  targetUser,
  targetChatIds,
  herePermissions,
  isAdminHere,
  newlyBlocked,
  persisted,
}: BanEverywhereParams): Promise<void> {
  // 每次 /block 都对每个群重新封禁；缺权限与失败的群重新欠一次补扫（见 infra/blocklist/crossChatBan.ts）。
  const bannedCount: number = await banBlockedIdentityInManagedChats({
    chatIds: targetChatIds,
    identityId: targetUser.id,
    isChannel: targetUser.isChannel === true,
  });

  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const targetLabel: string = formatTargetLabel(targetUser, atmosphere);
  const persistWarning: string = persisted ? "" : atmosphere.NOTICE_TEXTS.blockPersistFailed;
  if (bannedCount === 0) {
    const replyText: string = atmosphere.NOTICE_TEXTS.blockAllFailed(targetLabel, persistWarning);
    await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
    return;
  }

  // 本群没进清单时说明本群没封，原因由 describeBotPermissionGap 按权限快照给出
  // （见 libs/botPermissionGap.ts）。
  const hereGap: string | undefined = isAdminHere
    ? undefined
    : describeBotPermissionGap(herePermissions, "canRestrictMembers", atmosphere.NOTICE_TEXTS);
  const skippedHereNote: string = hereGap === undefined ? "" : atmosphere.NOTICE_TEXTS.blockSkippedHere(hereGap);
  const failedCount: number = targetChatIds.length - bannedCount;
  const failedNote: string = failedCount > 0 ? atmosphere.NOTICE_TEXTS.blockPartialFailure(failedCount) : "";
  // 已在名单里的目标再 /block 用 blockAlreadyRecorded，各群照样重新封禁；
  // 落盘警告两条路径都附带。
  const blocklistNote: string = newlyBlocked
    ? atmosphere.NOTICE_TEXTS.blockRecorded(persistWarning)
    : atmosphere.NOTICE_TEXTS.blockAlreadyRecorded(persistWarning);
  await sendCommandMessage({
    chatId,
    text: atmosphere.NOTICE_TEXTS.blockResult({ skippedHereNote, targetLabel, bannedCount, failedNote, blocklistNote }),
    replyToMessageId: messageId,
  });
}

/**
 * 处理 /block：动作放在末位，与 /white 同一口径——`/block <目标> enable` 拉黑、
 * `/block <目标> disable` 解除（commands/unblock.ts），回复目标时只写动作。动作缺省
 * 或不是 enable/disable 时回用法提示；两个动作各自校验权限
 * （isCanBlock / isCanUnBlock）。
 * @param ctx grammY 命令上下文。
 */
export async function handleBlockCommand(ctx: CommandContext<Context>): Promise<void> {
  const { last: rawAction, rest: targetArgument }: TrailingTokenSplit = splitTrailingToken(ctx.match);
  const action: ToggleAction | undefined = rawAction === undefined ? undefined : parseToggleAction(rawAction);
  if (action === undefined) {
    await replyCommandNotice(ctx, chatAtmosphere().NOTICE_TEXTS.blockUsage);
    return;
  }
  if (action === "enable") await blockTarget(ctx, targetArgument);
  else await handleBlockDisable(ctx, targetArgument);
}
