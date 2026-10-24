/**
 * cron 任务的单轮执行：按顺序投递全部动作，相邻动作与相邻会话之间均间隔 CRON_ACTION_GAP_MS。
 *
 * 重试与终止规则：
 * - 每个动作最多执行 1 次初始尝试加 `CRON_ACTION_RETRY_DELAYS_MS.length` 次重试。
 * - 可重试错误包括：网络错误（HttpError）、5xx、单会话或全局发送队列满（TelegramSendQueueFullError）、
 *   出站闸按 retry_after 退避后仍被限流的 429、语音合成的 Worker 暂不可用/未返回音频/等待超时，
 *   以及联网摘要组稿的 Worker 暂不可用/等待超时/检索或组稿请求失败。
 * - 不可重试错误包括：其余 4xx（含 MarkdownV2 解析失败）、合成能力缺席、额度用尽、音频编码失败、
 *   组稿不合格及本地文件错误。
 * - 动作最终失败时记录英文错误日志，并跳过当前会话剩余动作（不影响后续会话）。
 * - 任务因热重载撤销或进程停机时，不打断已在途的单次请求，而是在下一动作、下次重试或下一目标群前停止；
 *   停机超时后由 `signal` 取消在途请求与退避等待。
 *
 * 目标解析与轮内复用：
 * - `chat_id` 显式列出单个或多个会话时，按书写顺序直接投递，不预先查询发送权限。
 * - `["all"]` 与 `["except", ...]` 先经 `cron/targets.ts` 解析本轮可发送群，再按 `chatId` 升序逐群投递。
 * - 每轮新建 `CronRoundVoices` 与 `CronRoundDigests`：`send_voice` 与 `send_web_digest` 在本轮内仅合成或组稿一次，
 *   跨重试与跨会话复用（`send_voice` 首次上传成功后改用返回的 `file_id`），轮次结束即释放。
 */

import { CRON_ACTION_GAP_MS, CRON_ACTION_RETRY_DELAYS_MS, CRON_NO_EXCLUDED_CHAT_IDS } from "../consts/cron";
import { logger } from "../infra/logger";
import { sleep } from "../libs/sleep";
import { deliverCronAction } from "./delivery";
import { resolveCronGroupTargets } from "./targets";
import type {
  CronAction,
  CronChatTargets,
  CronDeliveryOutcome,
  CronGroupTargets,
  CronRoundDigests,
  CronRoundVoices,
  CronTaskSchedule,
} from "../types/cron";

/** 定时任务单轮执行期间共用的上下文，每轮创建一次。 */
interface CronRoundContext {
  /** 当前执行的定时任务调度项。 */
  readonly schedule: CronTaskSchedule;
  /** 停机取消信号。 */
  readonly signal: AbortSignal;
  /** 本轮已合成的语音缓存表（按动作索引复用音频字节与 `file_id`）。 */
  readonly voices: CronRoundVoices;
  /** 本轮已生成的联网摘要缓存表（按动作索引复用 MarkdownV2 正文）。 */
  readonly digests: CronRoundDigests;
}

/** 向一个会话投递所需的上下文；每个会话建一次，动作与重试共用。 */
interface CronDeliveryContext extends CronRoundContext {
  /** 目标会话 ID */
  readonly chatId: number;
  /** 本轮不是「只列出单个会话」（`["all"]`、`["except", ...]` 或列出多个会话）；日志据此写明是哪个会话。 */
  readonly perChat: boolean;
}

/** 一个动作连同重试的最终结果。 */
type CronActionResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly attempts: number; readonly detail: string };

/**
 * 调度已撤销或本轮已被取消。
 *
 * @param schedule 当前任务调度项
 * @param signal 取消信号
 * @returns 是否应停止本轮投递
 */
function isStopped(schedule: CronTaskSchedule, signal: AbortSignal): boolean {
  return schedule.cancelled || signal.aborted;
}

/**
 * 等待一段时间；被取消时返回 false，不抛出。
 *
 * @param ms 等待毫秒数
 * @param signal 取消信号
 * @returns 等待正常完成时返回 `true`，被取消时返回 `false`
 */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * 向一个会话投递一个动作，按分类重试。
 *
 * @param context 单会话投递上下文
 * @param action 待投递的定时动作
 * @returns 动作连同重试后的最终投递结果
 */
async function deliverWithRetries(
  { schedule, chatId, signal, voices, digests }: CronDeliveryContext,
  action: Readonly<CronAction>
): Promise<CronActionResult> {
  for (let attempt: number = 0; ; attempt++) {
    if (isStopped(schedule, signal)) return { kind: "stopped" };
    const outcome: CronDeliveryOutcome = await deliverCronAction({ chatId, action, signal, voices, digests });
    if (outcome.kind === "sent") return { kind: "delivered" };
    if (outcome.kind === "aborted") return { kind: "stopped" };
    const delay: number | undefined = CRON_ACTION_RETRY_DELAYS_MS[attempt];
    if (outcome.kind === "permanent" || delay === undefined) {
      return { kind: "failed", attempts: attempt + 1, detail: outcome.detail };
    }
    if (!await pause(delay, signal)) return { kind: "stopped" };
  }
}

/**
 * 向一个会话顺序投递全部动作。失败记一行日志并中止该会话剩余的动作；返回 false 表示
 * 本轮已被撤销或取消，调用方应整轮收场。
 *
 * @param context 单会话投递上下文
 * @returns 可继续处理后续会话时返回 `true`；本轮被撤销或取消时返回 `false`
 */
async function runActions(context: CronDeliveryContext): Promise<boolean> {
  const { schedule, chatId, signal, perChat }: CronDeliveryContext = context;
  const actions: readonly Readonly<CronAction>[] = schedule.task.actions;
  for (let index: number = 0; index < actions.length; index++) {
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return false;
    const action: Readonly<CronAction> = actions[index]!;
    const result: CronActionResult = await deliverWithRetries(context, action);
    if (result.kind === "stopped") return false;
    if (result.kind === "failed") {
      logger.error(perChat
        ? `Cron task "${schedule.task.name}" action #${index + 1} (${action.type}) failed in chat ${chatId} ` +
          `after ${result.attempts} attempt(s); skipping the remaining actions for this chat: ${result.detail}`
        : `Cron task "${schedule.task.name}" action #${index + 1} (${action.type}) failed after ` +
          `${result.attempts} attempt(s); skipping the remaining actions of this run: ${result.detail}`);
      return true;
    }
  }
  return true;
}

/**
 * 按会话顺序逐个执行整套动作；返回 false 表示本轮已被撤销或取消。
 *
 * 只有「逐个列出的单个会话」按整轮口径记日志；`["all"]`、`["except", ...]` 与列出多个
 * 会话时，失败日志一律写明是哪个会话。
 *
 * @param round 本轮共用上下文
 * @param chatIds 目标会话 ID 列表
 * @returns 全部会话处理完返回 `true`；本轮被撤销或取消时返回 `false`
 */
async function runChats(round: CronRoundContext, chatIds: readonly number[]): Promise<boolean> {
  const { schedule, signal, voices, digests }: CronRoundContext = round;
  const chatTargets: CronChatTargets = schedule.task.chatTargets;
  const perChat: boolean = chatTargets.kind !== "list" || chatIds.length > 1;
  for (let index: number = 0; index < chatIds.length; index++) {
    if (isStopped(schedule, signal)) return false;
    if (index > 0 && !await pause(CRON_ACTION_GAP_MS, signal)) return false;
    if (!await runActions({ schedule, signal, voices, digests, chatId: chatIds[index]!, perChat })) return false;
  }
  return true;
}

/**
 * 执行一个任务的一轮；不抛出。
 *
 * @param schedule 当前任务调度项
 * @param signal 取消信号
 */
export async function runCronRound(schedule: CronTaskSchedule, signal: AbortSignal): Promise<void> {
  const round: CronRoundContext = { schedule, signal, voices: new Map(), digests: new Map() };
  const chatTargets: CronChatTargets = schedule.task.chatTargets;
  if (chatTargets.kind === "list") {
    await runChats(round, chatTargets.chatIds);
    return;
  }
  const targets: CronGroupTargets = await resolveCronGroupTargets(
    schedule,
    chatTargets.kind === "except" ? chatTargets.chatIds : CRON_NO_EXCLUDED_CHAT_IDS,
    signal
  );
  if (!await runChats(round, targets.chatIds)) return;
  if (targets.skipped > 0) {
    logger.log(`Cron task "${schedule.task.name}" skipped ${targets.skipped} chat(s) without send permission.`);
  }
}
