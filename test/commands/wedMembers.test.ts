import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { FifoMap } from "../../packages/libs/fifoMap";
import type { ChatMember } from "grammy/types";
import { wedChats } from "../../packages/cache/main/wed";
import { resetWedMemberStates, wedMemberStates } from "../../packages/cache/main/wedMembers";
import { getOrCreateWedChat } from "../../packages/commands/wed/chats";
import { observeWedMembers } from "../../packages/commands/wed/members";
import { WED_MEMBER_LIMIT } from "../../packages/consts/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { isPresentMember } from "../../packages/libs/chatMember";
import { getOrCreateChatState } from "../../packages/infra/storage/stateStore";

function message(id: number, chatId: number = -1001, overrides: Record<string, unknown> = {}): never {
  const chat = { id: chatId, type: "supergroup" };
  return { chat, message: { chat, from: { id, first_name: "群友", is_bot: false }, text: "hi", ...overrides } } as never;
}

beforeEach(() => {
  wedChats.clear();
  resetWedMemberStates();
  getOrCreateChatState(-1001).isInitEnabled = true;
  getOrCreateChatState(-2000).isInitEnabled = true;
});

afterEach(() => {
  resetWedMemberStates();
  setSystemTime();
});

test("首次 /init 特许放行仍不提前建缓存，启用后才记录成员", () => {
  getOrCreateChatState(-1001).isInitEnabled = false;
  observeWedMembers(message(1, -1001, { text: "/init enable" }));
  expect(wedMemberStates.has(-1001)).toBeFalse();
  getOrCreateChatState(-1001).isInitEnabled = false;
  observeWedMembers(message(1));
  expect(wedMemberStates.has(-1001)).toBeFalse();
  getOrCreateChatState(-1001).isInitEnabled = true;
  observeWedMembers(message(1));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
});

test("每群独立滑窗：满额挤出进入最早的成员，再次发言不刷新进入时间，退群腾位后不挤人", () => {
  setSystemTime(new Date(1_000));
  for (let id = 1; id <= WED_MEMBER_LIMIT; id++) observeWedMembers(message(id));
  const state = wedMemberStates.get(-1001)!;
  const members = state.members;
  const revision = state.revision;
  setSystemTime(new Date(2_000));
  observeWedMembers(message(1));
  expect(state.revision).toBe(revision);
  expect(members.get(1)).toBe(1_000);
  observeWedMembers(message(WED_MEMBER_LIMIT + 1));
  expect(state.revision).toBe(revision + 1);
  expect(members).toBeInstanceOf(FifoMap);
  expect(members.size).toBe(WED_MEMBER_LIMIT);
  expect(members.has(1)).toBeFalse();
  expect(members.oldestKey()).toBe(2);
  expect([...members].at(-1)).toEqual([WED_MEMBER_LIMIT + 1, 2_000]);
  observeWedMembers(message(2, -2000));
  expect([...wedMemberStates.get(-2000)!.members]).toEqual([[2, 2_000]]);
  observeWedMembers(message(1, -1001, { left_chat_member: { id: 3 } }));
  observeWedMembers(message(WED_MEMBER_LIMIT + 2));
  expect(members.has(2)).toBeTrue();
  expect(members.has(3)).toBeFalse();
  expect(members.has(WED_MEMBER_LIMIT + 2)).toBeTrue();
  expect(members.size).toBe(WED_MEMBER_LIMIT);
});

test("墙钟回拨时新成员沿用已分配的最大进入时间，插入顺序与进入时间保持同序", () => {
  setSystemTime(new Date(5_000));
  observeWedMembers(message(1));
  setSystemTime(new Date(3_000));
  observeWedMembers(message(2));
  setSystemTime(new Date(6_000));
  observeWedMembers(message(3));
  expect([...wedMemberStates.get(-1001)!.members]).toEqual([[1, 5_000], [2, 5_000], [3, 6_000]]);
  expect(wedMemberStates.get(-1001)!.latestEnteredAt).toBe(6_000);
});

test("排除机器人、匿名群身份、私聊、回复和转发里的用户，只缓存实际发言者", () => {
  observeWedMembers(message(1, -1001, { from: { id: 1, is_bot: true } }));
  observeWedMembers(message(1, -1001, { sender_chat: { id: -1001, type: "supergroup" } }));
  observeWedMembers({ chat: { id: 1, type: "private" }, message: { from: { id: 1 } } } as never);
  expect(wedMemberStates.size).toBe(0);
  observeWedMembers(message(1, -1001, { reply_to_message: { from: { id: 2 } }, forward_origin: { sender_user: { id: 3 } } }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
  observeWedMembers(message(5, -1001, { new_chat_members: [{ id: 6 }] }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([1]);
});

test("频道发言、匿名服务用户和自动转发均不进入候选，也不创建群缓存", () => {
  const sender = { id: -2002, type: "channel", title: "频道" };
  observeWedMembers(message(1, -1001, { sender_chat: sender, from: { id: 777000, is_bot: true } }));
  observeWedMembers(message(1, -1001, { sender_chat: sender }));
  observeWedMembers(message(1, -1001, { sender_chat: { ...sender, id: -2003 }, is_automatic_forward: true }));
  observeWedMembers(message(1, -1001, { sender_chat: { ...sender, id: -2004 }, from: undefined }));
  expect(wedMemberStates.size).toBe(0);
  observeWedMembers(message(2));
  observeWedMembers(message(1, -1001, { sender_chat: sender }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([2]);
});

test("离群服务消息和 chat_member 移除 ID，restricted 只有 is_member 为真才算在群", () => {
  observeWedMembers(message(1));
  observeWedMembers(message(2));
  observeWedMembers(message(3, -1001, { left_chat_member: { id: 1 } }));
  expect([...wedMemberStates.get(-1001)!.members.keys()]).toEqual([2]);
  observeWedMembers({ chat: { id: -1001, type: "supergroup" }, chatMember: { new_chat_member: { user: { id: 2 }, status: "restricted", is_member: false } } } as never);
  expect(wedMemberStates.get(-1001)!.members.size).toBe(0);
});

test.each([
  [{ status: "creator" }, true],
  [{ status: "administrator" }, true],
  [{ status: "member" }, true],
  [{ status: "restricted", is_member: true }, true],
  [{ status: "restricted", is_member: false }, false],
  [{ status: "left" }, false],
  [{ status: "kicked" }, false],
] as const)("统一成员判定覆盖全部合法状态：%j", (member, expected) => {
  expect(isPresentMember(member as ChatMember)).toBe(expected);
});

test("成员权威表满额时拒绝建立新群交互，已有群仍可命中", () => {
  for (let id = 1; id <= STATE_MANAGED_CHAT_LIMIT; id++) getOrCreateWedChat(-id);
  expect(getOrCreateWedChat(-1000)).toBeUndefined();
  expect(wedChats.size).toBe(STATE_MANAGED_CHAT_LIMIT);
  expect(getOrCreateWedChat(-1)).toBe(wedChats.get(-1));
});

test("交互表与成员滑窗同界：2,000 个不同群只建立 STATE_MANAGED_CHAT_LIMIT 个交互", () => {
  let created: number = 0;
  for (let id = 1; id <= 2_000; id++) if (getOrCreateWedChat(-id) !== undefined) created++;
  expect(created).toBe(STATE_MANAGED_CHAT_LIMIT);
  expect(wedChats.size).toBe(STATE_MANAGED_CHAT_LIMIT);
});
