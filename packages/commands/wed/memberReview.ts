import { wedRuntime } from "../../cache/main/wed";
import { wedMemberReview } from "../../cache/main/wedMemberReview";
import { wedMemberStates } from "../../cache/main/wedMembers";
import {
  WED_MEMBER_REVIEW_INTERVAL_MS,
  WED_OPERATION_TIMEOUT_MS,
} from "../../consts/wed";
import { trackBackgroundTask } from "../../infra/backgroundTasks";
import { signalWithTimeout } from "../../libs/abortSignal";
import { onDiskIOReply } from "../../infra/diskIO/observers";
import { readPresentChatUser } from "../../infra/telegram/actions/membership";
import { sleep } from "../../libs/sleep";
import type { MidnightMaintenanceReply } from "../../types/diskIO/replies";
import type { ChatMemberPresence } from "../../types/telegram";
import type { CommandExecutorRuntime } from "../../types/commandExecutor";
import type { WedMemberReview, WedMemberState } from "../../types/wed";
import { removeWedMember } from "./persistence";

/** 复核单个群 `/wed` 成员集合的参数。 */
interface ReviewChatWedMembersOptions {
  /** 成员复核运行时状态。 */
  readonly review: WedMemberReview;
  /** 目标群 ID。 */
  readonly chatId: number;
  /** 群成员集合持久化状态。 */
  readonly state: WedMemberState;
  /** 下一次允许发起查询的单调时钟毫秒数。 */
  readonly nextCheckAt: number;
}

/**
 * 复核一个群快照里的成员，返回更新后的全局下一次允许查询时刻。
 * @param options 复核运行时状态（`review`）、目标群 ID（`chatId`）、群成员集合状态（`state`）与初始下一次允许查询时刻（`nextCheckAt`）。
 * @returns 更新后的全局下一次允许查询时刻。
 */
async function reviewChatWedMembers({
  review,
  chatId,
  state,
  nextCheckAt: initialNextCheckAt,
}: ReviewChatWedMembersOptions): Promise<number> {
  let nextCheckAt: number = initialNextCheckAt;
  const members: readonly number[] = [...state.members.keys()];
  for (const userId of members) {
    if (review.controller.signal.aborted) return nextCheckAt;
    if (wedMemberStates.get(chatId) !== state) break;
    if (!state.members.has(userId)) continue;
    let delay: number = nextCheckAt - performance.now();
    while (delay > 0) {
      await sleep(Math.ceil(delay), review.controller.signal);
      delay = nextCheckAt - performance.now();
    }
    if (review.controller.signal.aborted) return nextCheckAt;
    if (wedMemberStates.get(chatId) !== state) break;
    if (!state.members.has(userId)) continue;
    review.chatId = chatId;
    review.userId = userId;
    review.observed = false;
    nextCheckAt = performance.now() + WED_MEMBER_REVIEW_INTERVAL_MS;
    const signal: AbortSignal = signalWithTimeout(review.controller.signal, WED_OPERATION_TIMEOUT_MS);
    const presence: ChatMemberPresence = await readPresentChatUser({ chatId, userId, signal });
    const observed: boolean = review.observed;
    review.chatId = null;
    review.userId = null;
    review.observed = false;
    if (wedMemberStates.get(chatId) !== state || presence.kind === "chatDenied") break;
    if (presence.kind === "absent" && !signal.aborted && !observed) removeWedMember(chatId, userId);
  }
  return nextCheckAt;
}

/**
 * 按群遍历当前记录的 `/wed` 成员快照，串行调用 `getChatMember` 复核在群状态并限制全局查询间隔；
 * 仅移除确认已不在群（含 Telegram 以 `PARTICIPANT_ID_INVALID` 拒绝该用户 ID）且查询期间未在群内重新发言的成员。
 *
 * 某个群的成员集合在复核期间被替换或清除时，仅终止该群本轮复核并继续处理下一个群；
 * 整轮任务只在 `review.controller` 取消时提前结束。查询失败或群拒绝成员查询（机器人不在群或权限不足）时
 * 结束该群本轮复核并保留原有成员（见 docs/cn/04-invariants.md）。
 * @param review 成员复核运行时状态。
 */
async function reviewWedMembers(review: WedMemberReview): Promise<void> {
  let nextCheckAt: number = 0;
  try {
    for (const [chatId, state] of wedMemberStates) {
      if (review.controller.signal.aborted) return;
      nextCheckAt = await reviewChatWedMembers({ review, chatId, state, nextCheckAt });
    }
  } finally {
    review.chatId = null;
    review.userId = null;
    review.observed = false;
  }
}

/**
 * 接收 Disk I/O 午夜维护通知并触发 `/wed` 成员在群复核；
 * 启动尚未就绪时先暂存日期键，等待 `enableWedMemberReview` 补跑，且同一自然日或正在运行期间不重复叠加任务。
 * @param day 午夜通知对应的日期键（`YYYY-MM-DD`）。
 */
function requestWedMemberReview(day: string): void {
  const runtime: CommandExecutorRuntime | null = wedRuntime.current;
  const review: WedMemberReview | null = wedMemberReview.current;
  if (runtime === null || !runtime.accepting || review === null) return;
  if (!review.ready) {
    review.pendingDay = day;
    return;
  }
  if (review.running || review.lastDay === day) return;
  review.lastDay = day;
  review.running = true;
  const task: Promise<void> = reviewWedMembers(review).catch((error: unknown): void => {
    if (!review.controller.signal.aborted) throw error;
  }).finally((): void => { review.running = false; });
  trackBackgroundTask(runtime.tasks, task, "Failed to review wed membership:");
}

onDiskIOReply("midnightMaintenance", (reply: MidnightMaintenanceReply): void => {
  requestWedMemberReview(reply.day);
});

/** 创建本代接纳门；对外连接和启动恢复完成前不执行 Telegram 查询。 */
export function initWedMemberReview(): void {
  stopWedMemberReview();
  wedMemberReview.current = {
    controller: new AbortController(),
    ready: false,
    pendingDay: null,
    lastDay: null,
    running: false,
    chatId: null,
    userId: null,
    observed: false,
  };
}

/**
 * Bot 握手和启动恢复成功后开启接纳，并消费启动期间的午夜通知。
 * 复核接入既有 wedRuntime 排空，遵守 docs/cn/04-invariants.md 的停机和持久化边界。
 */
export function enableWedMemberReview(): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review === null) return;
  review.ready = true;
  if (review.pendingDay === null) return;
  const day: string = review.pendingDay;
  review.pendingDay = null;
  requestWedMemberReview(day);
}

/** 停机关闭通知接纳并取消当前复核；在途任务留在 wedRuntime 中等待真正结算。 */
export function stopWedMemberReview(): void {
  const review: WedMemberReview | null = wedMemberReview.current;
  if (review === null) return;
  review.controller.abort();
  wedMemberReview.current = null;
}
