import type { ChatMember, User } from "grammy/types";
import { isAdminStatus, isPresentMember } from "../../../libs/chatMember";
import { telegramApi } from "../client";
import { isChatMemberQueryDenied, isParticipantIdInvalid, logUnlessAborted, runTelegramAction } from "./core";
import { telegramSignal } from "../../../libs/telegramSignal";
import type { ChatMemberPresence } from "../../../types/telegram";
import type { TelegramApi } from "../../../types/telegramWorker";

type ChatMemberApi = Pick<TelegramApi, "getChatMember">;

interface GetChatMemberOptions {
  readonly api: ChatMemberApi;
  readonly chatId: number;
  readonly userId: number;
  /** 缺省表示本次调用不参与取消。 */
  readonly signal?: AbortSignal;
}

/**
 * 本模块经 TelegramApi 调用 getChatMember 的唯一入口。grammY 把 signal 放在第三个位置；
 * signal 经 telegramSignal 在类型边界适配后原样传入，缺省时传 undefined，即本次调用不参与取消。
 */
function getChatMember({
  api,
  chatId,
  userId,
  signal,
}: GetChatMemberOptions): Promise<ChatMember> {
  return api.getChatMember(chatId, userId, telegramSignal(signal));
}

/**
 * 一次成员探测的结局。`admin` 表示目标是群或频道的管理员/所有者，`present` 表示在群的非管理员成员，
 * `absent` 表示确认不在群；`participantInvalid` 是 Telegram 以 PARTICIPANT_ID_INVALID
 * 拒绝这个用户 ID；其余查询失败都是 `failed`。
 */
export type ChatMembershipProbeOutcome =
  | "admin"
  | "present"
  | "absent"
  | "participantInvalid"
  | "failed";

/** 查询成功时由成员记录得出的探测结局。 */
type ChatMembershipStatusOutcome = Exclude<ChatMembershipProbeOutcome, "participantInvalid" | "failed">;

function membershipStatusOutcome(member: ChatMember): ChatMembershipStatusOutcome {
  if (isAdminStatus(member.status)) return "admin";
  return isPresentMember(member) ? "present" : "absent";
}

/** 探测成员身份并保留管理员与 PARTICIPANT_ID_INVALID 分类；取消以外的查询失败照常记 API 错误。 */
export async function probeChatMembershipWithOutcome(
  chatId: number,
  userId: number,
  api: ChatMemberApi = telegramApi
): Promise<ChatMembershipProbeOutcome> {
  let participantInvalid: boolean = false;
  const outcome: ChatMembershipStatusOutcome | undefined =
    await runTelegramAction<ChatMember, ChatMembershipStatusOutcome | undefined>({
      action: `probe chat membership (chat ${chatId}, user ${userId})`,
      execute: (signal?: AbortSignal): Promise<ChatMember> =>
        getChatMember({ api, chatId, userId, signal }),
      map: membershipStatusOutcome,
      fallback: undefined,
      shouldLogError: (error: unknown): boolean => {
        participantInvalid = isParticipantIdInvalid(error);
        return true;
      },
    });
  if (outcome === undefined) return participantInvalid ? "participantInvalid" : "failed";
  return outcome;
}

/**
 * 把「确认不在群」与「查询失败」分开。
 * @returns 在群（含管理员）true、确认不在群 false、查询失败 undefined。
 */
export async function probeChatMembership(
  chatId: number,
  userId: number,
  api: ChatMemberApi = telegramApi
): Promise<boolean | undefined> {
  const outcome: ChatMembershipProbeOutcome =
    await probeChatMembershipWithOutcome(chatId, userId, api);
  if (outcome === "admin" || outcome === "present") return true;
  return outcome === "absent" ? false : undefined;
}

/** 管理员探测共用客户端与请求取消边界。 */
export interface ProbeChatAdminOptions {
  readonly chatId: number;
  readonly userId: number;
  readonly api?: ChatMemberApi;
  readonly signal?: AbortSignal;
}

/**
 * 目标此刻是不是这个群或频道的管理员/所有者。
 * @returns 确认是管理员 true、确认不是 false、查询失败 undefined。
 */
export async function probeChatAdmin(
  { chatId, userId, api = telegramApi, signal }: ProbeChatAdminOptions
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat admin (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): boolean =>
      isAdminStatus(member.status),
    fallback: undefined,
    signal,
  });
}

/** 取成员身份的两条路共用的查询边界：是否解释成员状态由各自的 map 决定。 */
export interface ChatMemberUserOptions {
  readonly chatId: number;
  readonly userId: number;
  readonly signal?: AbortSignal;
}

/**
 * 取本轮查询到的成员身份，不解释成员状态，离群与被踢同样返回身份。
 * 供 `/info` 现查目标资料（commands/info.ts 的 lookUp）与破坏性命令核对 @username 目标
 * （commands/liveTargetIdentity.ts）：要的是名称与用户名，不判断在不在群。
 * @returns 查询成功返回身份，查询失败返回 undefined。
 */
export function readChatMemberUser({ chatId, userId, signal }: ChatMemberUserOptions): Promise<User | undefined> {
  return runTelegramAction<ChatMember, User | undefined>({
    action: `read chat member identity (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api: telegramApi, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): User => member.user,
    fallback: undefined,
    signal,
  });
}

/**
 * 查询目标此刻是否在群，结局语义见 types/telegram.ts 的 ChatMemberPresence。
 * PARTICIPANT_ID_INVALID 按离群处理且不记 API 错误；本群拒绝查询与其它失败除停机
 * 取消外照常记一行 API 错误。
 */
export async function readPresentChatUser({ chatId, userId, signal }: ChatMemberUserOptions): Promise<ChatMemberPresence> {
  let participantInvalid: boolean = false;
  let chatDenied: boolean = false;
  const user: User | null | undefined = await runTelegramAction<ChatMember, User | null | undefined>({
    action: `read chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<ChatMember> =>
      getChatMember({ api: telegramApi, chatId, userId, signal: requestSignal }),
    map: (member: ChatMember): User | null => isPresentMember(member) ? member.user : null,
    fallback: undefined,
    signal,
    shouldLogError: (error: unknown, actionSignal: AbortSignal | undefined): boolean => {
      participantInvalid = isParticipantIdInvalid(error);
      chatDenied = isChatMemberQueryDenied(error);
      return !participantInvalid && logUnlessAborted(error, actionSignal);
    },
  });
  if (participantInvalid || user === null) return { kind: "absent" };
  if (user !== undefined) return { kind: "present", user };
  return { kind: chatDenied ? "chatDenied" : "failed" };
}
