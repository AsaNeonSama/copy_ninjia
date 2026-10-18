import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Api } from "grammy";
import type { RawApi, Transformer } from "grammy";
import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import type {
  TelegramSentMessage,
  TelegramSentPhotoMessage,
  TelegramWorkerApi,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
} from "../../packages/types/telegramWorker";
import { telegramOutboundGate } from "../../packages/infra/telegram/outboundGate";
import { drainTelegramOutbound, initTelegramOutbound, telegramOutboundStats } from "../../packages/infra/telegram/outboundLifecycle";
import { isSelfSent, waitForBotOwnMessage } from "../../packages/infra/selfSentTracker";
import type { Message, PhotoSize } from "grammy/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../packages/consts/aiChat/media";
import { pickPhotoFile } from "../../packages/libs/telegramImage";

const calls: { readonly method: string; readonly payload: any; readonly signal: AbortSignal | undefined }[] = [];
let owner: "ai" | "antiRaid" = "ai";
let retry: boolean = false;
let messageSequence: number = 900;
/** 非 null 时传输层在返回前等待它，用来观察请求在途期间的状态。 */
let hold: Promise<void> | null = null;
/** 发送类回执里随消息一起返回的被回复消息全文；null 表示没有回复关系。 */
let repliedTo: Message | null = null;
/** getChat 的回执；非发送类结果原样回传给 Worker。 */
const CHAT_INFO: Readonly<Record<string, unknown>> = {
  id: -1001, type: "supergroup", title: "mock", accent_color_id: 0, max_reaction_count: 11,
};
/** sendPhoto 回执的全部档位，按分辨率升序；最大一档声明超过视觉下载上限。 */
const SENT_PHOTO_SIZES: readonly PhotoSize[] = [
  { file_id: "p-small", file_unique_id: "p-small-u", width: 90, height: 90, file_size: 1_000 },
  { file_id: "p-middle", file_unique_id: "p-middle-u", width: 320, height: 320, file_size: 20_000 },
  { file_id: "p-large", file_unique_id: "p-large-u", width: 800, height: 800, file_size: MEDIA_MAX_DOWNLOAD_BYTES },
  { file_id: "p-huge", file_unique_id: "p-huge-u", width: 2560, height: 2560, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 },
];
const api: FileApiFlavor<Api> = new Api("123:test-only") as FileApiFlavor<Api>;
const transport: Transformer<RawApi> = async (...args: Parameters<Transformer<RawApi>>): Promise<any> => {
  const [, method, payload, signal]: Parameters<Transformer<RawApi>> = args;
  calls.push({ method, payload, signal: signal as AbortSignal | undefined });
  expect(telegramOutboundStats().active).toBeGreaterThan(0);
  if (hold !== null) await hold;
  if (retry) {
    retry = false;
    return { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 0 } };
  }
  if (method === "getFile") return { ok: true, result: { file_id: "file", file_unique_id: "unique", file_path: "files/test.bin" } };
  if (method === "getChat") return { ok: true, result: CHAT_INFO };
  const sent: Record<string, unknown> = {
    message_id: ++messageSequence,
    date: 1,
    chat: { id: -1001, type: "supergroup", title: "mock" },
    from: { id: 999, is_bot: true, first_name: "bot" },
    text: "mock",
  };
  if (repliedTo !== null) sent.reply_to_message = repliedTo;
  if (method === "sendPhoto") sent.photo = SENT_PHOTO_SIZES;
  return { ok: true, result: sent };
};
api.config.use(transport);
api.config.use(hydrateFiles("123:test-only"));
api.config.use(telegramOutboundGate());
mock.module("../../packages/infra/telegram/mainClient", () => ({ bot: { api } }));
mock.module("../../packages/libs/workerDuplex", () => ({
  requestMainThread: (request: TelegramWorkerRequest, signal?: AbortSignal): Promise<unknown> =>
    (owner === "ai" ? handleAiWorkerTelegramRequest : handleAntiRaidWorkerTelegramRequest)(request, signal ?? new AbortController().signal),
}));
const { handleAiWorkerTelegramRequest, handleAntiRaidWorkerTelegramRequest } =
  await import("../../packages/infra/telegram/workerRequests");
const { workerTelegramApi, downloadTelegramFileFromMain } = await import("../../packages/infra/telegram/workerClient");
const { installTelegramApi, telegramApi } = await import("../../packages/infra/telegram/client");
const { telegramApiState } = await import("../../packages/cache/perThread/telegramApi");

function assertWorkerApiContract(worker: TelegramWorkerApi): void {
  // @ts-expect-error 主线程专属复制能力不属于 Worker 接口。
  void worker.copyMessage;
  // @ts-expect-error 主线程专属编辑能力不属于 Worker 接口。
  void worker.editMessageText;
  // @ts-expect-error 主线程专属临时消息删除不属于 Worker 接口。
  void worker.deleteEphemeralMessage;
  // @ts-expect-error 目标专属消息发送只在主线程提供（回执要读完整 Message）。
  void worker.sendEphemeralMessage;
  // @ts-expect-error 主线程专属频道解封不属于 Worker 接口。
  void worker.unbanChatSenderChat;
  // @ts-expect-error 构造后的 Worker 代理方法不可替换。
  worker.sendMessage = async (): Promise<never> => { throw new Error("compile-only"); };
}
void assertWorkerApiContract;

/** Worker 侧发送回执只暴露投影后的字段；读完整 Message 的字段编译失败。 */
async function assertWorkerSendReceiptContract(worker: TelegramWorkerApi): Promise<void> {
  const text: TelegramSentMessage = await worker.sendMessage(-1001, "compile-only");
  // @ts-expect-error 投影后的文字回执不带 chat。
  void text.chat;
  // @ts-expect-error 被回复消息只带 message_id。
  void text.reply_to_message?.text;
  const photo: TelegramSentPhotoMessage = await worker.sendPhoto(-1001, { bytes: new Uint8Array(), fileName: "x.png" });
  // @ts-expect-error 投影后的图片回执不带 caption。
  void photo.caption;
  // @ts-expect-error 投影后的回执只读。
  photo.message_id = 0;
}
void assertWorkerSendReceiptContract;

beforeEach((): void => {
  calls.length = 0;
  owner = "ai";
  retry = false;
  hold = null;
  repliedTo = null;
  initTelegramOutbound();
});
afterEach(async (): Promise<void> => {
  await drainTelegramOutbound(0);
  telegramApiState.current = null;
});

test("每个 JSON 方法逐 owner 验证允许与拒绝，主线程专属方法两边均拒绝", async (): Promise<void> => {
  const permissions: Readonly<Record<TelegramWorkerJsonCall["method"], readonly boolean[]>> = {
    answerCallbackQuery: [false, true], banChatMember: [false, true], banChatSenderChat: [false, true],
    deleteMessage: [false, true], deleteMessages: [false, true], getChat: [false, true],
    getChatAdministrators: [false, true], getChatMember: [false, true], getStickerSet: [true, false],
    restrictChatMember: [false, true], sendChatAction: [true, false], sendMessage: [true, true],
    sendSticker: [true, false], setChatPermissions: [false, true], setMessageReaction: [true, false],
    unbanChatMember: [false, true],
  };
  const methods: readonly string[] = [...Object.keys(permissions), "copyMessage", "deleteEphemeralMessage", "editMessageText", "unbanChatSenderChat"];
  for (const [index, handler] of [handleAiWorkerTelegramRequest, handleAntiRaidWorkerTelegramRequest].entries()) {
    for (const method of methods) {
      const request: TelegramWorkerRequest = { operation: "call", call: { method, payload: { chat_id: -1001 } } } as TelegramWorkerRequest;
      const before: number = calls.length;
      const result: Promise<unknown> = handler(request, new AbortController().signal);
      if (permissions[method as TelegramWorkerJsonCall["method"]]?.[index] === true) {
        await result;
        expect(calls.at(-1)?.method).toBe(method);
        expect(calls.length).toBe(before + 1);
      } else {
        await expect(result).rejects.toThrow("unsupported Telegram capability");
        expect(calls.length).toBe(before);
      }
    }
  }
});

test("代理贯通真实接收端与出站闸，保留话题、429 重试和自发登记", async (): Promise<void> => {
  retry = true;
  const expectedMessageId: number = messageSequence + 1;
  expect(isSelfSent(-1001, expectedMessageId)).toBeFalse();
  const sent: Awaited<ReturnType<typeof workerTelegramApi.sendMessage>> = await workerTelegramApi.sendMessage(-1001, "hello", { message_thread_id: 71 });
  expect(sent.message_id).toBe(expectedMessageId);
  expect(calls).toHaveLength(2);
  expect(calls.every((call): boolean => call.method === "sendMessage" && call.payload.message_thread_id === 71)).toBeTrue();
  expect(isSelfSent(-1001, sent.message_id)).toBeTrue();
});

test("发送回执只回传消息 id、回复关系与选中的那一档图片，其余结果原样返回", async (): Promise<void> => {
  const plain: TelegramSentMessage = await workerTelegramApi.sendMessage(-1001, "plain");
  expect(plain).toStrictEqual({ message_id: messageSequence, reply_to_message: undefined });
  expect(Object.keys(plain)).toEqual(["message_id", "reply_to_message"]);

  repliedTo = {
    message_id: 42,
    date: 1,
    chat: { id: -1001, type: "supergroup", title: "mock" },
    from: { id: 7, is_bot: false, first_name: "user" },
    text: "被回复的原文",
    entities: [{ type: "bold", offset: 0, length: 3 }],
  } as Message;
  const reply: TelegramSentMessage = await workerTelegramApi.sendMessage(-1001, "reply");
  expect(reply).toStrictEqual({ message_id: messageSequence, reply_to_message: { message_id: 42 } });
  const sticker: TelegramSentMessage = await workerTelegramApi.sendSticker(-1001, "sticker-file-id");
  expect(sticker).toStrictEqual({ message_id: messageSequence, reply_to_message: { message_id: 42 } });
  const voice: TelegramSentMessage = await workerTelegramApi.sendVoice(-1001, { bytes: new Uint8Array([2]), fileName: "v.ogg" });
  expect(voice).toStrictEqual({ message_id: messageSequence, reply_to_message: { message_id: 42 } });
  const photo: TelegramSentPhotoMessage = await workerTelegramApi.sendPhoto(-1001, { bytes: new Uint8Array([1]), fileName: "p.png" });
  expect(photo).toStrictEqual({
    message_id: messageSequence,
    reply_to_message: { message_id: 42 },
    photo: [SENT_PHOTO_SIZES[2]!],
  });
  expect(pickPhotoFile(photo.photo)).toEqual(pickPhotoFile(SENT_PHOTO_SIZES));

  owner = "antiRaid";
  const chat: unknown = await workerTelegramApi.getChat(-1001);
  expect(chat).toStrictEqual(CHAT_INFO);
});

test("上传与 CDN 下载均经主线程出站闸；跨 owner 调用和取消不出站", async (): Promise<void> => {
  await workerTelegramApi.sendPhoto(-1001, { bytes: new Uint8Array([1]), fileName: "test.png" }, { message_thread_id: 72 });
  await workerTelegramApi.sendVoice(-1001, { bytes: new Uint8Array([2]), fileName: "test.ogg" }, { message_thread_id: 73 });
  expect(calls.map((call): string => call.method)).toEqual(["sendPhoto", "sendVoice"]);
  expect(calls[0]?.payload.message_thread_id).toBe(72);
  expect(calls[1]?.payload.message_thread_id).toBe(73);
  const originalFetch: typeof fetch = globalThis.fetch;
  let downloads: number = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    downloads++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(telegramOutboundStats().active).toBeGreaterThan(0);
    return new Response(new Uint8Array([3, 4]));
  }) as typeof fetch;
  try {
    await expect(downloadTelegramFileFromMain({ fileId: "file", purpose: "vision" })).resolves.toEqual({ status: "ok", bytes: new Uint8Array([3, 4]) });
    expect(downloads).toBe(1);
    expect(calls.at(-1)?.method).toBe("getFile");
    owner = "antiRaid";
    await expect(downloadTelegramFileFromMain({ fileId: "file", purpose: "vision" })).rejects.toThrow("unsupported Telegram capability");
    owner = "ai";
    const controller: AbortController = new AbortController();
    controller.abort();
    const before: number = calls.length;
    await expect(workerTelegramApi.sendMessage(-1001, "cancelled", {}, controller.signal as never)).rejects.toThrow();
    expect(calls.length).toBe(before);
    expect(downloads).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("自发消息在途计数由主线程按方法与操作判定：产消息请求计入，查询请求不计入", async (): Promise<void> => {
  const channelPost = (messageId: number): Message =>
    ({ chat: { id: -1001, type: "channel", title: "channel" }, message_id: messageId, date: 0 }) as Message;
  let release: () => void = (): void => undefined;
  hold = new Promise<void>((resolve: () => void): void => { release = resolve; });
  owner = "antiRaid";
  const query: Promise<unknown> = workerTelegramApi.getChat(-1001);
  while (calls.length < 1) await Bun.sleep(1);
  expect(await waitForBotOwnMessage(channelPost(messageSequence + 1), 1_000)).toBeFalse();
  release();
  await query;

  hold = new Promise<void>((resolve: () => void): void => { release = resolve; });
  owner = "ai";
  const sent: Promise<unknown> = workerTelegramApi.sendMessage(-1001, "hello");
  while (calls.length < 2) await Bun.sleep(1);
  const waiting: Promise<boolean> = waitForBotOwnMessage(channelPost(messageSequence + 1), 1_000);
  release();
  await sent;
  expect(await waiting).toBeTrue();
});

test("Worker 代理没有主线程专属方法，共享门面在本地拒绝这些方法", (): void => {
  installTelegramApi(workerTelegramApi);
  expect("copyMessage" in workerTelegramApi).toBeFalse();
  expect("deleteEphemeralMessage" in workerTelegramApi).toBeFalse();
  expect("editMessageText" in workerTelegramApi).toBeFalse();
  expect("unbanChatSenderChat" in workerTelegramApi).toBeFalse();
  expect(() => telegramApi.copyMessage(-1001, -1002, 1)).toThrow("only available on the main thread");
  expect(() => telegramApi.editMessageText(-1001, 1, "test")).toThrow("only available on the main thread");
  expect(() => telegramApi.deleteEphemeralMessage({ chatId: -1001, receiverUserId: 1, ephemeralMessageId: 1 })).toThrow("only available on the main thread");
  expect(() => telegramApi.unbanChatSenderChat(-1001, -1002)).toThrow("only available on the main thread");
  expect(calls).toHaveLength(0);
});
