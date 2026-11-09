/**
 * 广告命中后的本群处罚（禁言、只踢不封、本群封禁、频道身份只删消息）与处置播报文案。
 * 动作由 states/adPunishment.ts 按 ad_detect_config.json 的处罚等级选定，由 antiRaid/adDetect.ts
 * 在该身份的黑名单串行位里调用；永久黑名单与全部受管群封禁不经过本模块。
 * 本群处罚不写 durable outbox：在途任务由 inFlightAdDisposals 跟踪，停机排空预算耗尽或进程重启即放弃
 * （见 docs/cn/04-invariants.md）。
 */
import { chatIsSupergroupById } from "../cache/main/antiRaid/chatKind";
import { MUTE_DISPATCH_MIN_REMAINING_MS } from "../consts/commands";
import { SECOND_MS } from "../consts/time";
import { chatAtmosphere } from "../infra/atmosphere";
import { isUserBlocked } from "../infra/blocklist/membership";
import { logger } from "../infra/logger";
import {
  banChatMemberWithOutcome,
  kickChatMemberWithOutcome,
  muteChatMemberPermanentlyWithOutcome,
  muteChatMemberWithOutcome,
  probeChatMembership,
} from "../infra/telegram";
import type {
  BanChatMemberOutcome,
  KickChatMemberOutcome,
  MuteChatMemberOutcome,
} from "../infra/telegram";
import { sendTemporaryMessageOnMain } from "../infra/telegram/temporaryMessage";
import { formatDurationCn } from "../libs/durationToken";
import type { AdDetectedEvent } from "../types/antiRaid/adDetect";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { AtmosphereNotices } from "../types/atmosphereNotices";
import type { AdInChatPunishmentAction } from "../types/states/adPunishment";

/** 生成广告处置播报开头一句（展示标签与判定理由）所需的参数。 */
export interface FormatAdNoticeHeadParams {
  /** 发送者的展示标签（见 users/userLabel.ts 的 formatUserLabel）。 */
  readonly label: string;
  /** 模型返回的判定理由；空串时使用默认文案。 */
  readonly reason: string;
  /** 当前机器人的群氛围文案表。 */
  readonly atmosphere: AtmosphereTexts;
}

/**
 * 生成广告处置播报的开头一句：只含展示标签与判定理由，不回显广告原文；各处罚的结果句接在其后。
 * @param params 展示标签、判定理由与氛围文案表。
 * @returns 播报开头一句。
 */
export function formatAdNoticeHead({ label, reason, atmosphere }: FormatAdNoticeHeadParams): string {
  return atmosphere.NOTICE_TEXTS.adDetected(label, reason || atmosphere.NOTICE_TEXTS.adDefaultReason);
}

/** 生成本群处罚播报文案所需的参数。 */
export interface FormatInChatAdNoticeParams extends FormatAdNoticeHeadParams {
  /** 已执行的本群处罚动作。 */
  readonly action: AdInChatPunishmentAction;
  /** 处罚请求是否已确认生效；`deleteOnly` 不发请求，取值不参与文案。 */
  readonly punished: boolean;
}

/**
 * 生成本群处罚的群内播报文案：处罚未生效时统一提示管理员检查权限，频道身份只说明消息已删除。
 * @param params 展示标签、判定理由、处罚动作、是否生效与氛围文案表。
 * @returns 组装完成的播报文案。
 */
export function formatInChatAdNotice(params: FormatInChatAdNoticeParams): string {
  const head: string = formatAdNoticeHead(params);
  const notices: Readonly<AtmosphereNotices> = params.atmosphere.NOTICE_TEXTS;
  const { action }: FormatInChatAdNoticeParams = params;
  if (action.kind === "deleteOnly") return notices.adDeletedOnly(head);
  if (!params.punished) return notices.adPunishFailed(head);
  if (action.kind === "kick") return notices.adKicked(head);
  if (action.kind === "banChat") return notices.adChatBanned(head);
  return action.durationMs === null
    ? notices.adMutedPermanently(head)
    : notices.adMuted(head, formatDurationCn(action.durationMs));
}

/**
 * 在触发群禁言广告发送者：限时禁言沿用 `/mute` 的派发截止契约（时长减去 MUTE_DISPATCH_MIN_REMAINING_MS），
 * 永久禁言不带 `until_date`。
 * @param event Worker 上报的广告命中事件。
 * @param durationMs 禁言时长（毫秒）；null 表示永久禁言。
 * @returns 禁言请求确认生效时返回 true。
 */
async function muteAdSender(event: AdDetectedEvent, durationMs: number | null): Promise<boolean> {
  const outcome: MuteChatMemberOutcome = durationMs === null
    ? await muteChatMemberPermanentlyWithOutcome({ chatId: event.chatId, userId: event.senderId })
    : await muteChatMemberWithOutcome({
      chatId: event.chatId,
      userId: event.senderId,
      mutedUntil: Date.now() + durationMs,
      dispatchTimeoutMs: durationMs - MUTE_DISPATCH_MIN_REMAINING_MS,
    });
  if (outcome === "muted") {
    logger.log(
      `Ad detection muted sender ${event.senderId} in chat ${event.chatId} ` +
      `${durationMs === null ? "permanently" : `for ${Math.round(durationMs / SECOND_MS)}s`}.`
    );
    return true;
  }
  logger.error(`Ad detection could not mute sender ${event.senderId} in chat ${event.chatId}: ${outcome}.`);
  return false;
}

/**
 * 把广告发送者移出触发群但不封禁。超级群的「只踢不封」走 `unbanChatMember`，对已封禁身份有解除封禁语义：
 * 发送者已在永久黑名单时交给黑名单封禁，不再踢；踢前先确认目标仍在群（见 docs/cn/04-invariants.md）。
 * 群类型读主线程 chatIsSupergroupById，未知时不猜测移出接口。
 * @param event Worker 上报的广告命中事件。
 * @returns 已移出或确认目标已不在群时返回 true。
 */
async function kickAdSender(event: AdDetectedEvent): Promise<boolean> {
  if (isUserBlocked(event.senderId)) {
    logger.log(
      `Ad detection left sender ${event.senderId} in chat ${event.chatId} to the blocklist ban: ` +
      "the identity is already on the permanent blocklist."
    );
    return true;
  }
  const isSupergroup: boolean | undefined = chatIsSupergroupById.get(event.chatId);
  if (isSupergroup === undefined) {
    logger.error(
      `Ad detection could not kick sender ${event.senderId} in chat ${event.chatId}: ` +
      "the chat kind is unknown, so no removal API is guessed."
    );
    return false;
  }
  const present: boolean | undefined = await probeChatMembership(event.chatId, event.senderId);
  if (present === false) {
    logger.log(`Ad detection found sender ${event.senderId} already gone from chat ${event.chatId}; nothing to kick.`);
    return true;
  }
  if (present === undefined) {
    logger.error(
      `Ad detection could not kick sender ${event.senderId} in chat ${event.chatId}: ` +
      "membership could not be confirmed, so no removal was issued."
    );
    return false;
  }
  const outcome: KickChatMemberOutcome = await kickChatMemberWithOutcome({
    chatId: event.chatId,
    userId: event.senderId,
    isSupergroup,
  });
  if (outcome === "kicked" || outcome === "absent") {
    logger.log(`Ad detection kicked sender ${event.senderId} from chat ${event.chatId} without a ban.`);
    return true;
  }
  logger.error(`Ad detection could not kick sender ${event.senderId} in chat ${event.chatId}: ${outcome}.`);
  return false;
}

/**
 * 只在触发群封禁广告发送者（banChatMember 带 `revoke_messages`），不写永久黑名单。
 * @param event Worker 上报的广告命中事件。
 * @returns 封禁请求确认生效时返回 true。
 */
async function banAdSenderInChat(event: AdDetectedEvent): Promise<boolean> {
  const outcome: BanChatMemberOutcome = await banChatMemberWithOutcome(event.chatId, event.senderId);
  if (outcome === "banned") {
    logger.log(`Ad detection banned sender ${event.senderId} in chat ${event.chatId} only.`);
    return true;
  }
  logger.error(`Ad detection could not ban sender ${event.senderId} in chat ${event.chatId}: ${outcome}.`);
  return false;
}

/**
 * 按动作分派本群处罚请求。
 * @param event Worker 上报的广告命中事件。
 * @param action 已选定的本群处罚动作。
 * @returns 处罚请求确认生效时返回 true；`deleteOnly` 不发请求，返回 true。
 */
async function runInChatAdPunishment(
  event: AdDetectedEvent,
  action: AdInChatPunishmentAction
): Promise<boolean> {
  if (action.kind === "mute") return await muteAdSender(event, action.durationMs);
  if (action.kind === "kick") return await kickAdSender(event);
  if (action.kind === "banChat") return await banAdSenderInChat(event);
  logger.log(
    `Ad detection only deleted the messages of channel sender ${event.senderId} in chat ${event.chatId}: ` +
    "the configured punishment cannot apply to a channel identity."
  );
  return true;
}

/**
 * 在触发群执行本群处罚，并经统一临时消息边界发送处置播报（见 infra/telegram/temporaryMessage.ts）。
 * @param event Worker 上报的广告命中事件。
 * @param action 已选定的本群处罚动作。
 */
export async function punishAdSenderInChat(
  event: AdDetectedEvent,
  action: AdInChatPunishmentAction
): Promise<void> {
  const punished: boolean = await runInChatAdPunishment(event, action);
  await sendTemporaryMessageOnMain({
    chatId: event.chatId,
    text: formatInChatAdNotice({
      label: event.label,
      reason: event.reason,
      action,
      punished,
      atmosphere: chatAtmosphere(),
    }),
  });
}
