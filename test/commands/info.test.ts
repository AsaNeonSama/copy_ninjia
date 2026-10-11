import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MessageEntity, User } from "grammy/types";
import type { CachedUser } from "../../packages/types/chatState";
import type { CurrentAvatarResult } from "../../packages/types/telegram";
import { replyCommandNoticeVia } from "../helpers/common";

const sendCommandMessage = mock(async (..._args: unknown[]): Promise<number | undefined> => 1);
const sendCommandPhoto = mock(async (..._args: unknown[]): Promise<number | undefined> => 2);
let memberUser: User | undefined;
const readChatMemberUser = mock(async (..._args: unknown[]): Promise<User | undefined> => memberUser);
let avatar: CurrentAvatarResult = { status: "permanent-failure" };
const readCurrentAvatar = mock(async (..._args: unknown[]): Promise<CurrentAvatarResult> => avatar);
let chatInfo: unknown;
const getChat = mock(async (..._args: unknown[]): Promise<unknown> => {
  if (chatInfo === undefined) throw new Error("Bad Request: chat not found");
  return chatInfo;
});
let resolvedTarget: CachedUser | undefined;
const resolveCommandTarget = mock(async (..._args: unknown[]): Promise<CachedUser | undefined> => resolvedTarget);

mock.module("../../packages/infra/telegram", () => ({ sendCommandMessage, replyCommandNotice: replyCommandNoticeVia(sendCommandMessage) }));
mock.module("../../packages/infra/telegram/commandPhotos", () => ({ sendCommandPhoto }));
mock.module("../../packages/infra/telegram/actions/membership", () => ({ readChatMemberUser }));
mock.module("../../packages/infra/telegram/avatar/read", () => ({ readCurrentAvatar }));
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api: { getChat } } }));
mock.module("../../packages/commands/targetResolution", () => ({ resolveCommandTarget }));

const { handleInfoCommand } = await import("../../packages/commands/info");
const { drainDeferredCommandRuntime, initDeferredCommandRuntime } = await import("../../packages/commands/deferredCommands");
const { deferredCommandRuntime } = await import("../../packages/cache/main/deferredCommands");
const { chatAtmosphere } = await import("../../packages/infra/atmosphere");

const CHAT_ID: number = -1001;
const BOT: User = { id: 999, is_bot: true, first_name: "Copy", last_name: "Ninjia", username: "copy_ninjia_bot" };
const texts = chatAtmosphere().INFO_TEXTS;

function context(match: string = ""): never {
  return {
    chat: { id: CHAT_ID, type: "supergroup" },
    msgId: 10,
    msg: { message_id: 10, chat: { id: CHAT_ID, type: "supergroup" } },
    match,
    me: BOT,
  } as never;
}

async function runInfo(match: string = ""): Promise<void> {
  await handleInfoCommand(context(match));
  expect(await drainDeferredCommandRuntime(5_000)).toBe("flushed");
  // 排空会停止接纳；同一用例里再查一次要换一代执行器。
  initDeferredCommandRuntime();
}

/** 期望回执的资料。 */
interface ExpectedInfo {
  readonly name: string;
  readonly username: string;
  readonly id: number;
  readonly withAvatar: boolean;
}

/** 发出去的回执：纯文字走 text/entities，带图走 caption/captionEntities。 */
interface SentInfo {
  readonly chatId: number;
  readonly photo?: string | Uint8Array;
  readonly replyToMessageId?: number;
  readonly messageThreadId?: number;
  readonly text?: string;
  readonly entities?: readonly MessageEntity[];
  readonly caption?: string;
  readonly captionEntities?: readonly MessageEntity[];
}

/**
 * 核对回执正文逐行是名称、用户名、ID（没有头像时再加一行头像标签），标签取当前通知风格的常量；
 * 唯一的 code 实体按 Telegram 的 UTF-16 偏移恰好圈住 id。
 */
function expectInfoBody(text: string | undefined, entities: readonly MessageEntity[] | undefined, info: ExpectedInfo): void {
  const lines: string[] = [`${texts.nameLabel}${info.name}`, `${texts.usernameLabel}${info.username}`, `${texts.idLabel}${info.id}`];
  if (!info.withAvatar) lines.push(texts.noAvatar);
  expect(text?.split("\n")).toEqual(lines);
  expect(entities).toHaveLength(1);
  const entity: MessageEntity = entities![0]!;
  expect(entity.type).toBe("code");
  expect(text!.slice(entity.offset, entity.offset + entity.length)).toBe(String(info.id));
}

/** 最近一条纯文字回执只带这几个字段：回复触发消息、不带话题，正文与实体见 expectInfoBody。 */
function expectLastInfoMessage(info: ExpectedInfo): void {
  const sent: SentInfo = sendCommandMessage.mock.calls.at(-1)![0] as SentInfo;
  expect(sent).toEqual({
    chatId: CHAT_ID,
    text: expect.any(String),
    entities: expect.any(Array),
    replyToMessageId: 10,
    messageThreadId: undefined,
  });
  expectInfoBody(sent.text, sent.entities, info);
}

beforeEach(() => {
  for (const mocked of [sendCommandMessage, sendCommandPhoto, readChatMemberUser, readCurrentAvatar, getChat, resolveCommandTarget]) {
    mocked.mockClear();
  }
  sendCommandPhoto.mockImplementation(async (): Promise<number | undefined> => 2);
  memberUser = undefined;
  avatar = { status: "permanent-failure" };
  chatInfo = undefined;
  resolvedTarget = undefined;
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async () => {
  await drainDeferredCommandRuntime(0);
});

describe("/info", () => {
  test("目标解析接受回复、@username、用户 id、会话 id，也允许机器人自己", async () => {
    await handleInfoCommand(context("@alice"));
    expect(resolveCommandTarget.mock.calls[0]![0]).toMatchObject({
      chatId: CHAT_ID, rawArgument: "@alice", botUserId: 999, acceptUserId: true, acceptChatId: true, allowSelfTarget: true,
    });
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("用户：现查本群成员身份，名称拼接 first 与 last，带头像时发图、id 用 code 实体", async () => {
    resolvedTarget = { id: 42, username: "stale" };
    memberUser = { id: 42, is_bot: false, first_name: "Alice", last_name: "Liddell", username: "alice" };
    avatar = { status: "ok", identity: memberUser, photo: "avatar-file-id" };
    await runInfo("42");
    expect(readChatMemberUser).toHaveBeenCalledWith(expect.objectContaining({ chatId: CHAT_ID, userId: 42 }));
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(memberUser);
    expect(sendCommandPhoto).toHaveBeenCalledTimes(1);
    const photo: SentInfo = sendCommandPhoto.mock.calls[0]![0] as SentInfo;
    expect(photo).toEqual({
      chatId: CHAT_ID,
      photo: "avatar-file-id",
      caption: expect.any(String),
      captionEntities: expect.any(Array),
      replyToMessageId: 10,
      messageThreadId: undefined,
    });
    expectInfoBody(photo.caption, photo.captionEntities, { name: "Alice Liddell", username: "@alice", id: 42, withAvatar: true });
    expect(sendCommandMessage).not.toHaveBeenCalled();
  });

  test("没有头像或带图发送失败时回纯文字，注明头像：无", async () => {
    resolvedTarget = { id: 42 };
    memberUser = { id: 42, is_bot: false, first_name: "Alice" };
    await runInfo("42");
    expectLastInfoMessage({ name: "Alice", username: texts.noUsername, id: 42, withAvatar: false });

    avatar = { status: "ok", identity: memberUser, photo: new Uint8Array([1]) };
    sendCommandPhoto.mockImplementation(async (): Promise<number | undefined> => undefined);
    await runInfo("42");
    expect(sendCommandPhoto).toHaveBeenCalledTimes(1);
    expect(sendCommandMessage).toHaveBeenCalledTimes(2);
    expectLastInfoMessage({ name: "Alice", username: texts.noUsername, id: 42, withAvatar: false });
  });

  test("机器人自己：直接用自身资料，不再现查成员身份", async () => {
    resolvedTarget = { id: 999 };
    await runInfo();
    expect(readChatMemberUser).not.toHaveBeenCalled();
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(BOT);
    expect(sendCommandMessage).toHaveBeenCalledTimes(1);
    expectLastInfoMessage({ name: "Copy Ninjia", username: "@copy_ninjia_bot", id: 999, withAvatar: false });
  });

  test("频道：getChat 取 title 与用户名，按 id 读头像；群身份没有头像可读", async () => {
    resolvedTarget = { id: -1002, isChannel: true };
    chatInfo = { id: -1002, type: "channel", title: "News", username: "news" };
    await runInfo("-1002");
    expect(readCurrentAvatar.mock.calls[0]![0]).toBe(-1002);
    expectLastInfoMessage({ name: "News", username: "@news", id: -1002, withAvatar: false });

    readCurrentAvatar.mockClear();
    chatInfo = { id: -1003, type: "supergroup", title: "Group" };
    resolvedTarget = { id: -1003, isChannel: true };
    await runInfo("-1003");
    expect(readCurrentAvatar).not.toHaveBeenCalled();
  });

  test("现查失败时退回解析得到的身份；连名称和用户名都没有时回查不到", async () => {
    resolvedTarget = { id: 42, first_name: "Cached", username: "cached" };
    await runInfo("42");
    expectLastInfoMessage({ name: "Cached", username: "@cached", id: 42, withAvatar: false });

    resolvedTarget = { id: 43 };
    await runInfo("43");
    expect(sendCommandMessage).toHaveBeenLastCalledWith({ chatId: CHAT_ID, text: texts.notFound, replyToMessageId: 10 });
  });

  test("名称含 emoji 等代理对字符时，id 实体按 UTF-16 偏移仍圈住 id", async () => {
    resolvedTarget = { id: 42 };
    memberUser = { id: 42, is_bot: false, first_name: "Alice 🐇", username: "alice" };
    await runInfo("42");
    expectLastInfoMessage({ name: "Alice 🐇", username: "@alice", id: 42, withAvatar: false });
  });

  test("名称里的命令与双向控制字符被中和", async () => {
    resolvedTarget = { id: 42 };
    memberUser = { id: 42, is_bot: false, first_name: "/batch_kick", last_name: "‮evil" };
    await runInfo("42");
    const text: string = (sendCommandMessage.mock.calls[0]![0] as { text: string }).text;
    expect(text).not.toContain("/batch_kick");
    expect(text).not.toContain("‮");
  });

  test("执行器停止接纳时回「稍后再试」", async () => {
    resolvedTarget = { id: 42 };
    deferredCommandRuntime.current!.accepting = false;
    await handleInfoCommand(context("42"));
    expect(sendCommandMessage).toHaveBeenCalledWith({ chatId: CHAT_ID, text: texts.busy, replyToMessageId: 10 });
  });
});
