import { describe, expect, test } from "bun:test";
import {
  banChatMemberWithOutcome,
  events,
  handleRemoveBlockedMembers,
  probeChatMembershipWithOutcome,
  publish,
  quiesceAntiRaidDispatch,
  settle,
} from "./blocklistEffectsHarness";

/**
 * 补扫处置里 PARTICIPANT_ID_INVALID 的判定：只有补扫中全部探测与封禁都被这样拒绝、
 * 且未被停机打断才报进回执；重试次数与未落定判定保持不变。
 */

describe("黑名单处置的 PARTICIPANT_ID_INVALID 观测（守卫线程侧）", () => {
  test("补扫里探测与封禁全部 PARTICIPANT_ID_INVALID：照常重试且算未落定，回执报出该 id", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 50 },
      publish,
    });
    await settle();

    // 重试次数与未落定判定都不变：计数只由主线程按回执累加。
    expect(probeChatMembershipWithOutcome).toHaveBeenCalledTimes(3);
    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 50, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [7], settledUserIds: [] }]);
  });

  test("任一次请求不是 PARTICIPANT_ID_INVALID，这次处置就不计入销号", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    let bans: number = 0;
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> =>
      ++bans === 2 ? "failed" : "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 51 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events[0]?.complete).toBeFalse();
    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("探测失败但不是 PARTICIPANT_ID_INVALID 时同样不计入", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "failed");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 52 },
      publish,
    });
    await settle();

    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("秒踢批次不读成员身份，封禁的 PARTICIPANT_ID_INVALID 不计入", async () => {
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: false, removalId: 53 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 53, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [], settledUserIds: [] }]);
  });

  test("停机取消打断的重试不计入销号", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (): Promise<string> => "participantInvalid");
    banChatMemberWithOutcome.mockImplementation(async (): Promise<string> => {
      quiesceAntiRaidDispatch();
      return "participantInvalid";
    });

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7], probeMembership: true, removalId: 54 },
      publish,
    });
    await settle();

    expect(banChatMemberWithOutcome).toHaveBeenCalledTimes(1);
    expect(events[0]?.participantInvalidUserIds).toEqual([]);
  });

  test("混合批次按处置顺序分别报出销号观测与已落定 id", async () => {
    probeChatMembershipWithOutcome.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<string> => {
      if (userId === 7 || userId === 10) return "participantInvalid";
      return userId === 8 ? "absent" : "present";
    });
    banChatMemberWithOutcome.mockImplementation(async (_chatId: unknown, userId: unknown): Promise<string> =>
      userId === 7 || userId === 10 ? "participantInvalid" : "banned");

    handleRemoveBlockedMembers({
      msg: { type: "removeBlockedMembers", chatId: -1001, userIds: [7, 8, 9, 10], probeMembership: true, removalId: 55 },
      publish,
    });
    await settle();

    expect(events).toEqual([{ type: "blockedMembersRemoved", chatId: -1001, removalId: 55, complete: false, permissionDenied: false, targetIsAdmin: false, participantInvalidUserIds: [7, 10], settledUserIds: [8, 9] }]);
  });
});
