/**
 * 黑名单处置副作用（workers/antiRaid/blocklistEffects.ts）用例共用的夹具：Telegram 出站、入群补记与
 * 广告去重回收换成替身，退避与补扫批量压到测试尺度。导入本模块即登记 beforeEach 复位。
 */

import { beforeEach, mock } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { waitUntil } from "../../helpers/waitUntil";
import type { BlockedMembersRemovedEvent } from "../../../packages/types/antiRaid";

async function presentMemberStub(..._args: unknown[]): Promise<string> {
  return "present";
}
async function bannedStub(..._args: unknown[]): Promise<string> {
  return "banned";
}
async function notAdminStub(..._args: unknown[]): Promise<boolean | undefined> {
  return false;
}
async function deletedStub(..._args: unknown[]): Promise<boolean> {
  return true;
}

export const probeChatMembershipWithOutcome = mock(presentMemberStub);
export const banChatMemberWithOutcome = mock(bannedStub);
export const banChatSenderChatWithOutcome = mock(bannedStub);
export const probeChatAdmin = mock(notAdminStub);
export const deleteMessage = mock(deletedStub);
export const recordJoin = mock((..._args: unknown[]): void => {});
export const releaseAdDetectDedupKey = mock((..._args: unknown[]): void => {});
/** 入群守卫调用面的替身：断言处置始终使用受限 Worker 能力边界。 */
export const guardApi: { readonly kind: "guard-api" } = { kind: "guard-api" };

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub(),
}));
mock.module("../../../packages/infra/telegram", () => ({
  probeChatAdmin,
  banChatMemberWithOutcome,
  banChatSenderChatWithOutcome,
  deleteMessage,
  telegramApi: guardApi,
}));
mock.module("../../../packages/infra/telegram/actions/membership", () => ({
  probeChatMembershipWithOutcome,
}));
mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({ recordJoin }));
mock.module("../../../packages/workers/antiRaid/adDetect/queueState", () => ({
  releaseAdDetectDedupKey,
}));
// 退避间隔与补扫批量在测试里压缩，不改变分支。
mock.module("../../../packages/consts/antiRaid/blocklist", () => ({
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS: 3,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS: 1,
  BLOCKLIST_SWEEP_BATCH_SIZE: 2,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS: 1,
}));

export const { handleRemoveBlockedMembers } = await import("../../../packages/workers/antiRaid/blocklistEffects");
const botPermissionsModule = await import("../../../packages/workers/antiRaid/botPermissions");
const blocklistCache = await import("../../../packages/cache/workers/antiRaid/blocklist");
const taskTracker = await import("../../../packages/workers/antiRaid/taskTracker");
export const { applyBotPermissionsChange } = botPermissionsModule;
export const { bumpBlocklistRemovalEpoch } = blocklistCache;
export const { drainAntiRaidTasks, quiesceAntiRaidDispatch } = taskTracker;

/** 本用例收到的落定回执，按发出顺序；每条用例开始前清空。 */
export const events: BlockedMembersRemovedEvent[] = [];
export function publish(event: BlockedMembersRemovedEvent): void {
  events.push(event);
}

/** 轮询同步点的兜底上限，到点未成立时交给随后的断言报告失败。 */
const SETTLE_TIMEOUT_MS: number = 2_000;

/** 轮询等到条件成立；到点仍不成立就返回，让后面的断言给出真正的失败信息。 */
export async function until(ready: () => boolean): Promise<void> {
  await waitUntil(ready, SETTLE_TIMEOUT_MS);
}

/**
 * 等这批处置发出落定回执。
 *
 * handleRemoveBlockedMembers 在 removeBlockedMembers 完成之后（成功或异常）恒发且只发一条回执，
 * 回执到达即这批的探测、封禁、删公告、补记入群全部结束。
 */
export function settle(): Promise<void> {
  return until((): boolean => events.length > 0);
}

beforeEach(() => {
  for (const mocked of [
    probeChatMembershipWithOutcome,
    banChatMemberWithOutcome,
    banChatSenderChatWithOutcome,
    probeChatAdmin,
    deleteMessage,
    recordJoin,
    releaseAdDetectDedupKey,
  ]) {
    mocked.mockReset();
  }
  probeChatMembershipWithOutcome.mockImplementation(presentMemberStub);
  banChatMemberWithOutcome.mockImplementation(bannedStub);
  banChatSenderChatWithOutcome.mockImplementation(bannedStub);
  probeChatAdmin.mockImplementation(notAdminStub);
  deleteMessage.mockImplementation(deletedStub);
  events.length = 0;
  // 换回未 abort 的停机取消信号，并清空上一条用例留下的在途任务。
  taskTracker.resetAntiRaidTaskTracker();
  blocklistCache.blocklistRemovalEpochs.clear();
  botPermissionsModule.resetWorkerBotPermissions();
});
