import {
  combineWithUpdateAbortSignal,
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../updateContext";
import { beginSelfSentSend, endSelfSentSend } from "../../selfSentTracker";
import { isAbortError } from "../../../libs/abortSignal";
import { logApiError } from "../client";
import { telegramErrorDetails } from "../errors";

interface RunTelegramActionParams<T, R> {
  /** 日志中记录的动作描述。 */
  action: string;
  /** 接收合成取消信号并发起 Telegram 请求的函数。 */
  execute: (signal?: AbortSignal) => Promise<T>;
  /** 将 API 原始响应转换为业务结果的函数。 */
  map: (result: T) => R;
  /** 请求或转换失败时返回的兜底值。 */
  fallback: R;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 是否把这次失败记成 API 错误；第二个参数是 runTelegramAction 已算好的复合信号，直接复用。
   * 缺省为 logUnlessAborted（调用方 signal 已中止时不记）。
   */
  shouldLogError?: (
    error: unknown,
    actionSignal: AbortSignal | undefined
  ) => boolean;
  /**
   * map 会对这个 chat 调用 `markSelfSent` 时传入：请求发出前登记在途发送，
   * map 之后的同一同步段结算（见 infra/selfSentTracker.ts）。
   */
  selfSentChatId?: number;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也在同一个错误
 * 边界内：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。主动 API 调用失败按业务结果返回 fallback，
 * 不经 grammY 的 bot.catch（它处理 update/middleware 逃逸异常）。
 *
 * 失败本身是取消（isAbortError，例如 Worker 停机 drain 撤销的双工请求）时不记
 * API 错误；`shouldLogError` 仍会被调用，供调用方完成结局分类。
 * @param params 动作执行、结果映射与错误处理参数。
 * @returns 成功时返回映射后的结果，失败时返回 fallback。
 */
export async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  signal,
  shouldLogError = logUnlessAborted,
  selfSentChatId,
}: RunTelegramActionParams<T, R>): Promise<R> {
  const updateSignal: AbortSignal | undefined =
    currentUpdateAbortSignal();
  const actionSignal: AbortSignal | undefined =
    combineWithUpdateAbortSignal(signal);
  throwIfUpdateAborted(updateSignal);
  if (selfSentChatId !== undefined) beginSelfSentSend(selfSentChatId);
  try {
    const mapped: R = map(await execute(actionSignal));
    // 先完成 map 中的 self-sent 记账，再把 update 取消向上抛出，
    // handler 不再继续后续业务写入。
    throwIfUpdateAborted(updateSignal);
    return mapped;
  } catch (error: unknown) {
    if (updateSignal?.aborted === true) {
      throwIfUpdateAborted(updateSignal);
    }
    if (shouldLogError(error, actionSignal) && !isAbortError(error)) {
      logApiError(action, error);
    }
    return fallback;
  } finally {
    if (selfSentChatId !== undefined) endSelfSentSend(selfSentChatId);
  }
}

/**
 * runTelegramAction 缺省的 `shouldLogError`：调用方 signal 已中止时的失败不记 API 错误。
 *
 * 只对带调用方 signal 的动作有意义（update 取消在判据之前已由统一边界上抛，
 * 取消形状的失败由 runTelegramAction 统一不记）。各 Telegram 动作入口共用；
 * runPermissionAwareTelegramAction 在分类后同样经过本函数。
 * @param _error 捕获到的异常值（本判据不读取）。
 * @param actionSignal 动作合成后的取消信号。
 * @returns 动作信号未中止时返回 true，已中止时返回 false。
 */
export function logUnlessAborted(
  _error: unknown,
  actionSignal: AbortSignal | undefined
): boolean {
  return actionSignal?.aborted !== true;
}

/**
 * 执行只关心是否成功的 Telegram 动作。
 * @param action 日志中记录的动作描述。
 * @param execute 发起 Telegram 请求的函数。
 * @param signal 调用方的取消信号。
 * @returns 请求成功返回 true，失败返回 false。
 */
export async function runBooleanTelegramAction(
  action: string,
  execute: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  return runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
  });
}

/** 一次权限敏感动作的归一化结局；调用方再翻译成自己的领域词。 */
export type PermissionAwareOutcome =
  | "succeeded"
  /** 由 claimError 认领的领域结局（如「目标已不在群」），既非权限也非故障。 */
  | "claimed"
  | "forbidden"
  /** Telegram 以 PARTICIPANT_ID_INVALID 拒绝目标用户 ID；照常记 API 错误。 */
  | "participantInvalid"
  | "failed";

export interface RunPermissionAwareTelegramActionParams {
  /** 日志中记录的动作描述。 */
  action: string;
  /** 发起 Telegram 请求的函数。 */
  execute: (signal?: AbortSignal) => Promise<unknown>;
  /** 调用方的取消信号。 */
  signal?: AbortSignal;
  /**
   * 领域先认领这次错误：返回 true 表示已经归类完毕，本函数不再按权限解释、
   * 也不记 API 错误日志。`/batch_kick` 的「目标本来就不在群」就是这种结局。
   */
  claimError?: (error: unknown) => boolean;
}

/**
 * 执行一次需要区分「权限拒绝」与「偶发失败」的 Telegram 动作。
 *
 * mute / unmute / kick / ban / ban sender chat 共用这一权限闩锁与结果映射；
 * 不关心 `participantInvalid` 的调用方把它归入 `failed`。
 * 权限拒绝（见 isPermissionDenied）归为 `forbidden`，不归入偶发的 `failed`。
 *
 * 取消造成的失败不记 API 错误，口径与 runBooleanTelegramAction 一致。
 * @param params 权限敏感动作的执行与错误认领参数。
 * @returns 区分成功、领域认领、权限拒绝、无效参与者与偶发失败的五态结局。
 */
export async function runPermissionAwareTelegramAction({
  action,
  execute,
  signal,
  claimError,
}: RunPermissionAwareTelegramActionParams): Promise<PermissionAwareOutcome> {
  let outcome: PermissionAwareOutcome = "failed";
  const succeeded: boolean = await runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (
      error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => {
      if (claimError?.(error) === true) {
        outcome = "claimed";
        return false;
      }
      outcome = isPermissionDenied(error)
        ? "forbidden"
        : isParticipantIdInvalid(error) ? "participantInvalid" : "failed";
      return logUnlessAborted(error, actionSignal);
    },
  });
  return succeeded ? "succeeded" : outcome;
}

/** 挂回复时 Telegram 要的那一段；各发送入口共用同一份形状。 */
export interface TelegramReplyParameters {
  readonly message_id: number;
  readonly allow_sending_without_reply: true;
}

/**
 * 将可选的目标消息 ID 转换为 Bot API 的 `reply_parameters`（`allow_sending_without_reply` 恒为 true）。
 * @param replyToMessageId 要回复的目标消息 ID。
 * @returns 给定有效消息 ID 时返回 reply_parameters 对象，否则返回 undefined。
 */
export function replyParametersFor(
  replyToMessageId: number | undefined
): TelegramReplyParameters | undefined {
  return replyToMessageId ? { message_id: replyToMessageId, allow_sending_without_reply: true } : undefined;
}

/**
 * 判断 Telegram 错误是否属于操作权限不足。
 * @param error 待判定的异常值。
 * @returns 属于 403 或 400 权限不足错误时返回 true，否则返回 false。
 */
export function isPermissionDenied(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return false;
  if (details.errorCode === 403) return true;
  return (
    details.errorCode === 400 &&
    /not enough rights/i.test(details.description)
  );
}

/**
 * 判断 Telegram 错误是否属于本群成员查询本身被拒（机器人不在群或需管理员权限）。
 * @param error 待判定的异常值。
 * @returns 属于 403 或 CHAT_ADMIN_REQUIRED 错误时返回 true，否则返回 false。
 */
export function isChatMemberQueryDenied(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details === undefined) return false;
  if (details.errorCode === 403) return true;
  return details.errorCode === 400 && /\bCHAT_ADMIN_REQUIRED\b/.test(details.description);
}

/**
 * 判断 Telegram 错误是否以 `PARTICIPANT_ID_INVALID` 拒绝目标用户 ID。
 * @param error 待判定的异常值。
 * @returns 属于 400 PARTICIPANT_ID_INVALID 错误时返回 true，否则返回 false。
 */
export function isParticipantIdInvalid(error: unknown): boolean {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  return details?.errorCode === 400 &&
    /\bPARTICIPANT_ID_INVALID\b/.test(details.description);
}
