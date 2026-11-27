import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sticker } from "grammy/types";
import {
  adDetectAgentConfigCache,
  defaultAdDetectConfigCache,
} from "../../../packages/cache/perThread/config";
import { adPackBlacklistCounts } from "../../../packages/cache/workers/antiRaid/adDetect";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../../packages/consts/aiChat/media";
import { AD_DETECT_MAX_IMAGES_PER_BUNDLE } from "../../../packages/consts/antiRaid/adDetect";
import type { AdPackBlacklistKind } from "../../../packages/types/adPackBlacklist";
import type {
  AdCandidateMessage,
  AdVerdict,
  ClassifyAdBundleOptions,
} from "../../../packages/types/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../packages/types/config";
import type {
  TelegramApi,
  TelegramWorkerDownloadFileResult,
  TelegramWorkerTemporaryMessageResult,
} from "../../../packages/types/telegramWorker";
import type { DisposeAdSenderParams } from "../../../packages/workers/antiRaid/adDetect/disposal";
import { loggerStub } from "../../helpers/loggerMock";

const PNG_BYTES: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const INVALID_IMAGE_BYTES: Uint8Array = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const classifyCalls: ClassifyAdBundleOptions[] = [];
const classifyAdText = mock(async (
  params: ClassifyAdBundleOptions
): Promise<AdVerdict | null> => {
  classifyCalls.push(params);
  return { isAd: false, reason: "" };
});
const disposeAdSender = mock((..._args: unknown[]): void => {});
const warnReferencedAdSender = mock(async (): Promise<TelegramWorkerTemporaryMessageResult | undefined> => ({
  messageId: 555,
  sentAt: 1_000,
}));
const deleteReferencedAdMessages = mock((..._args: unknown[]): void => {});
const deleteStragglerAdMessage = mock((_chatId: number, _messageId: number): void => {});
const deleteMessage = mock(async (..._args: unknown[]): Promise<boolean> => true);
const getCustomEmojiStickers = mock(async (_ids: readonly string[]): Promise<Sticker[]> => []);
const downloadTelegramFileFromMain = mock(async (
  _params: { readonly fileId: string; readonly purpose: "vision" | "voice" }
): Promise<TelegramWorkerDownloadFileResult> => ({
  status: "ok",
  bytes: PNG_BYTES,
}));
const sendTemporaryMessageFromMain = mock(async (): Promise<TelegramWorkerTemporaryMessageResult | undefined> => ({
  messageId: 555,
  sentAt: 1_000,
}));
const cachedAdmins: Map<number, Set<number>> = new Map<number, Set<number>>();
const fetchedAdmins: Map<number, Set<number>> = new Map<number, Set<number>>();
const warnLogs: unknown[][] = [];
const errorLogs: unknown[][] = [];

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({
    warn(...args: unknown[]): void { warnLogs.push(args); },
    error(...args: unknown[]): void { errorLogs.push(args); },
  }),
}));
mock.module("../../../packages/workers/antiRaid/adDetect/classifier", () => ({
  classifyAdText,
}));
const realTelegram = await import("../../../packages/infra/telegram");
const mockedTelegramApi: TelegramApi = {
  ...realTelegram.telegramApi,
  getCustomEmojiStickers,
};
mock.module("../../../packages/infra/telegram", () => ({
  ...realTelegram,
  deleteMessage,
  telegramApi: mockedTelegramApi,
}));
mock.module("../../../packages/infra/telegram/workerClient", () => ({
  downloadTelegramFileFromMain,
  sendTemporaryMessageFromMain,
}));
mock.module("../../../packages/workers/antiRaid/adDetect/disposal", () => ({
  disposeAdSender,
  warnReferencedAdSender,
  deleteReferencedAdMessages,
  deleteStragglerAdMessage,
}));
const blacklistedEmojiPacks: Set<string> = new Set<string>();
mock.module("../../../packages/workers/antiRaid/adDetect/blacklistLookup", () => ({
  requestMatchAdPackBlacklist: async (
    kind: AdPackBlacklistKind,
    packs: readonly string[]
  ): Promise<string | null> => {
    if (kind !== "emoji") return null;
    for (const pack of packs) {
      if (blacklistedEmojiPacks.has(pack)) return pack;
    }
    return null;
  },
}));
mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  freshAdminIds: (chatId: number): Set<number> | undefined => cachedAdmins.get(chatId),
  isChatAdmin: async (chatId: number, userId: number): Promise<boolean | undefined> => {
    const cached: Set<number> | undefined = cachedAdmins.get(chatId);
    if (cached !== undefined) return cached.has(userId);
    const admins: Set<number> | undefined = fetchedAdmins.get(chatId);
    return admins === undefined ? undefined : admins.has(userId);
  },
}));

const {
  enqueueAdCandidate,
  runAdDetectBatch,
  stopAdDetectQueue,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const { pendingAdBundle } =
  await import("../../../packages/workers/antiRaid/adDetect/queueState");
const {
  adDetectVisionSupport,
  customEmojiMetaCache,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");

const originalAgentConfig: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;

/** 构造带默认字段的广告候选消息夹具。 */
function candidate(overrides: Partial<AdCandidateMessage> = {}): AdCandidateMessage {
  return {
    type: "adCandidate",
    chatId: -1001,
    senderId: 7,
    messageId: 1,
    observedAt: 1_000,
    text: "",
    firstName: "",
    lastName: "",
    username: "spammer",
    isChannel: false,
    isForwarded: false,
    blocked: false,
    justJoined: false,
    linkUrls: undefined,
    stickerSetName: undefined,
    stickerFileId: undefined,
    stickerFileUniqueId: undefined,
    imageFileId: undefined,
    imageFileUniqueId: undefined,
    customEmojiIds: undefined,
    sampleQuote: undefined,
    sampleReplyTo: undefined,
    ...overrides,
  };
}

/** 构造 `getCustomEmojiStickers` 返回的自定义表情贴纸夹具。 */
function emojiSticker(
  id: string,
  setName: string | undefined,
  overrides: Partial<Sticker> = {}
): Sticker {
  return {
    file_id: `f-${id}`,
    file_unique_id: `u-${id}`,
    type: "custom_emoji",
    width: 100,
    height: 100,
    is_animated: false,
    is_video: false,
    custom_emoji_id: id,
    set_name: setName,
    ...overrides,
  };
}

beforeEach((): void => {
  stopAdDetectQueue();
  defaultAdDetectConfigCache.current = {
    punishment: { kind: "kick", blockScope: "global" },
    samples: [],
  };
  adDetectAgentConfigCache.current = {
    provider: "openai",
    apiKey: "test-key",
    baseUrl: "https://ad.example/v1",
    model: "test-vision-model",
  };
  classifyCalls.length = 0;
  warnLogs.length = 0;
  errorLogs.length = 0;
  classifyAdText.mockReset();
  classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict | null> => {
    classifyCalls.push(params);
    return { isAd: false, reason: "" };
  });
  disposeAdSender.mockClear();
  warnReferencedAdSender.mockReset();
  warnReferencedAdSender.mockImplementation(async (): Promise<TelegramWorkerTemporaryMessageResult> => ({
    messageId: 555,
    sentAt: 1_000,
  }));
  deleteReferencedAdMessages.mockClear();
  deleteStragglerAdMessage.mockClear();
  deleteMessage.mockClear();
  getCustomEmojiStickers.mockReset();
  getCustomEmojiStickers.mockImplementation(async (): Promise<Sticker[]> => []);
  downloadTelegramFileFromMain.mockReset();
  downloadTelegramFileFromMain.mockImplementation(async (): Promise<TelegramWorkerDownloadFileResult> => ({
    status: "ok",
    bytes: PNG_BYTES,
  }));
  sendTemporaryMessageFromMain.mockClear();
  cachedAdmins.clear();
  fetchedAdmins.clear();
  fetchedAdmins.set(-1001, new Set<number>());
  blacklistedEmojiPacks.clear();
});

afterEach((): void => {
  adDetectAgentConfigCache.current = originalAgentConfig;
});

describe("广告检测多模态媒体解析与包归因", () => {
  test("emoji_black_list 为空时仍解析自定义表情，严格按 custom_emoji_id 建缓存并对缺省 ID 写负缓存", async () => {
    // 响应顺序刻意颠倒，且省略 emoji-missing；验证按 custom_emoji_id 映射而非数组下标。
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-anim", "AnimEmojiPack", {
        is_animated: true,
        file_id: "tgs-main-file",
        file_unique_id: "u-anim",
        thumbnail: {
          file_id: "thumb-anim-file",
          file_unique_id: "u-thumb-anim",
          width: 100,
          height: 100,
        },
      }),
      emojiSticker("emoji-video-no-thumb", "NoThumbPack", {
        is_video: true,
        file_id: "webm-main-file",
        file_unique_id: "u-video",
        thumbnail: undefined,
      }),
      emojiSticker("emoji-static", "StaticEmojiPack"),
    ]);

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "🔥✨🎯",
      customEmojiIds: ["emoji-static", "emoji-anim", "emoji-video-no-thumb", "emoji-missing"],
    }), 1_000);
    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
    expect(customEmojiMetaCache.peek("emoji-static")).toEqual({
      setName: "StaticEmojiPack",
      visionFileId: "f-emoji-static",
      fileUniqueId: "u-emoji-static",
    });
    expect(customEmojiMetaCache.peek("emoji-anim")).toEqual({
      setName: "AnimEmojiPack",
      visionFileId: "thumb-anim-file",
      fileUniqueId: "u-anim",
    });
    expect(customEmojiMetaCache.peek("emoji-video-no-thumb")).toEqual({
      setName: "NoThumbPack",
      visionFileId: null,
      fileUniqueId: "u-video",
    });
    expect(customEmojiMetaCache.peek("emoji-missing")).toEqual({
      setName: null,
      visionFileId: null,
      fileUniqueId: null,
    });

    // 只下载具备可用视觉源的两枚自定义表情，且动态表情走缩略图 file_id。
    expect(downloadTelegramFileFromMain.mock.calls.map((call) => call[0].fileId)).toEqual([
      "f-emoji-static",
      "thumb-anim-file",
    ]);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments?.map((item) => ({
      id: item.id,
      kind: item.kind,
      packName: item.packName,
      mime: item.image.mime,
    }))).toEqual([
      { id: "custom_emoji_1", kind: "custom_emoji", packName: "StaticEmojiPack", mime: "image/png" },
      { id: "custom_emoji_2", kind: "custom_emoji", packName: "AnimEmojiPack", mime: "image/png" },
    ]);
    expect(classifyCalls[0]?.emojiPackCandidates).toEqual(["StaticEmojiPack", "AnimEmojiPack"]);

    // 下一条再次出现 emoji-missing 时直接命中负缓存，不再请求 Telegram。
    enqueueAdCandidate(candidate({
      senderId: 8,
      messageId: 2,
      text: "重复缺省表情",
      customEmojiIds: ["emoji-missing"],
    }), 1_100);
    await runAdDetectBatch(1_100);
    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
  });

  test("快路径未命中 emoji_black_list 时媒体层复用 customEmojiMetaCache，不重复调用 getCustomEmojiStickers", async () => {
    blacklistedEmojiPacks.add("AlreadyBlockedPack");
    adPackBlacklistCounts.sticker = 0;
    adPackBlacklistCounts.emoji = 1;
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-clean", "NewAdEmojiPack"),
    ]);

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "👀",
      customEmojiIds: ["emoji-clean"],
    }), 1_000);
    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(classifyCalls[0]?.emojiPackCandidates).toEqual(["NewAdEmojiPack"]);
  });

  test("同时汇总普通图片、贴纸与自定义表情，按 fileUniqueId 去重并截断至 AD_DETECT_MAX_IMAGES_PER_BUNDLE 张", async () => {
    downloadTelegramFileFromMain.mockImplementation(async ({ fileId }) => ({
      status: "ok",
      bytes: fileId.startsWith("photo-") ? JPEG_BYTES : PNG_BYTES,
    }));
    const bannerIds: string[] = Array.from(
      { length: AD_DETECT_MAX_IMAGES_PER_BUNDLE + 2 },
      (_unused: unknown, index: number): string => `tile-${index}`
    );
    getCustomEmojiStickers.mockImplementationOnce(async (ids: readonly string[]): Promise<Sticker[]> =>
      ids.map((id: string): Sticker => emojiSticker(id, "BannerEmojiPack")));

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      imageFileId: "photo-1",
      imageFileUniqueId: "u-photo-1",
    }), 1_000);
    // 同一张 photo（相同 fileUniqueId）重复发送时只下载一次。
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "",
      imageFileId: "photo-1-dup",
      imageFileUniqueId: "u-photo-1",
    }), 1_050);
    enqueueAdCandidate(candidate({
      messageId: 3,
      text: "",
      stickerSetName: "StickerAdPack",
      stickerFileId: "sticker-1",
      stickerFileUniqueId: "u-sticker-1",
    }), 1_100);
    // 拼接横幅式多枚自定义表情（各 tile 的 fileUniqueId 不同），与前面的照片和贴纸合计截断至 8 张。
    enqueueAdCandidate(candidate({
      messageId: 4,
      text: "横幅",
      customEmojiIds: bannerIds,
    }), 1_200);

    await runAdDetectBatch(1_200);

    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(AD_DETECT_MAX_IMAGES_PER_BUNDLE);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments).toHaveLength(AD_DETECT_MAX_IMAGES_PER_BUNDLE);
    expect(classifyCalls[0]?.attachments?.[0]).toMatchObject({
      id: "photo_1",
      kind: "photo",
      packName: undefined,
      image: { mime: "image/jpeg" },
    });
    expect(classifyCalls[0]?.attachments?.[1]).toMatchObject({
      id: "sticker_1",
      kind: "sticker",
      packName: "StickerAdPack",
      image: { mime: "image/png" },
    });
    expect(classifyCalls[0]?.attachments?.[2]).toMatchObject({
      id: "custom_emoji_1",
      kind: "custom_emoji",
      packName: "BannerEmojiPack",
    });
    expect(classifyCalls[0]?.stickerPackCandidates).toEqual(["StickerAdPack"]);
    expect(classifyCalls[0]?.emojiPackCandidates).toEqual(["BannerEmojiPack"]);
  });

  test("单张下载、格式或超限失败仅记录 warning 并跳过，不影响同束其他图片与正文；纯媒体全失败不调 AI", async () => {
    const oversizedPng: Uint8Array = new Uint8Array(MEDIA_MAX_DOWNLOAD_BYTES + 1);
    oversizedPng.set(PNG_BYTES, 0);
    downloadTelegramFileFromMain.mockImplementation(async ({ fileId }): Promise<TelegramWorkerDownloadFileResult> => {
      if (fileId === "fail-status") return { status: "downloadTimeout" };
      if (fileId === "fail-throw") throw new Error("duplex error");
      if (fileId === "fail-format") return { status: "ok", bytes: INVALID_IMAGE_BYTES };
      if (fileId === "fail-size") return { status: "ok", bytes: oversizedPng };
      return { status: "ok", bytes: PNG_BYTES };
    });

    enqueueAdCandidate(candidate({ messageId: 1, text: "正文保留", imageFileId: "fail-status", imageFileUniqueId: "u1" }), 1_000);
    enqueueAdCandidate(candidate({ messageId: 2, text: "", imageFileId: "fail-throw", imageFileUniqueId: "u2" }), 1_010);
    enqueueAdCandidate(candidate({ messageId: 3, text: "", imageFileId: "fail-format", imageFileUniqueId: "u3" }), 1_020);
    enqueueAdCandidate(candidate({ messageId: 4, text: "", imageFileId: "fail-size", imageFileUniqueId: "u4" }), 1_030);
    enqueueAdCandidate(candidate({
      messageId: 5,
      text: "",
      stickerSetName: "GoodStickerPack",
      stickerFileId: "ok-sticker",
      stickerFileUniqueId: "u5",
    }), 1_040);

    await runAdDetectBatch(1_040);

    expect(warnLogs).toHaveLength(4);
    expect(errorLogs).toEqual([]);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.text).toBe("1. 正文保留");
    expect(classifyCalls[0]?.attachments?.map((item) => item.id)).toEqual(["sticker_1"]);
    expect(classifyCalls[0]?.stickerPackCandidates).toEqual(["GoodStickerPack"]);

    // 纯媒体消息全部下载失败时，直接判 notAd 并推进水位，不发空载荷给分类器。
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({
      senderId: 8,
      messageId: 6,
      text: "",
      imageFileId: "fail-status",
      imageFileUniqueId: "u6",
    }), 1_100);
    await runAdDetectBatch(1_100);
    expect(classifyCalls).toHaveLength(0);
    expect(pendingAdBundle(-1001, 8)?.checkedSeq).toBe(1);
  });

  test("adDetectVisionSupport 为 unsupported 时：非决策模型跳过下载（纯媒体不调 AI），Google 决策模型仍正常下载", async () => {
    adDetectVisionSupport.current = "unsupported";
    adDetectAgentConfigCache.current = {
      provider: "openai",
      apiKey: "key",
      baseUrl: "https://ad.example/v1",
      model: "text-only-model",
    };

    // 纯图片消息在 unsupported 态直接跳过下载与分类。
    enqueueAdCandidate(candidate({
      senderId: 7,
      messageId: 1,
      text: "",
      imageFileId: "photo-skip",
      imageFileUniqueId: "u-skip",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(downloadTelegramFileFromMain).not.toHaveBeenCalled();
    expect(classifyCalls).toHaveLength(0);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(1);

    // 文本+图片消息在 unsupported 态跳过下载，但照常按纯文本分类。
    enqueueAdCandidate(candidate({
      senderId: 8,
      messageId: 2,
      text: "日入过千",
      imageFileId: "photo-skip-2",
      imageFileUniqueId: "u-skip-2",
    }), 1_100);
    await runAdDetectBatch(1_100);
    expect(downloadTelegramFileFromMain).not.toHaveBeenCalled();
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.text).toBe("1. 日入过千");
    expect(classifyCalls[0]?.attachments).toBeUndefined();

    // Google + useDecision=true 不受 unsupported 门控阻断，仍正常下载图片并送检。
    adDetectAgentConfigCache.current = {
      provider: "google",
      apiKey: "google-key",
      baseUrl: undefined,
      model: "gemini-decision-model",
      useDecision: true,
    };
    enqueueAdCandidate(candidate({
      senderId: 9,
      messageId: 3,
      text: "",
      imageFileId: "photo-decision",
      imageFileUniqueId: "u-decision",
    }), 1_200);
    await runAdDetectBatch(1_200);
    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(classifyCalls).toHaveLength(2);
    expect(classifyCalls[1]?.attachments).toHaveLength(1);
  });

  test("纯转发广告图片与贴纸走 referencedOnly，警告期内升级处置也不透传任何包归因", async () => {
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return {
        isAd: true,
        reason: "转发贴纸广告",
        adStickerPacks: ["ForwardedAdPack"],
      };
    });

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      isForwarded: true,
      stickerSetName: "ForwardedAdPack",
      stickerFileId: "fwd-sticker-1",
      stickerFileUniqueId: "u-fwd-1",
    }), 1_000);
    await runAdDetectBatch(1_000);

    // 仅调用一次分类（无本人直发文本也无直发图片，直接判定为 referencedOnly）。
    expect(classifyCalls).toHaveLength(1);
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).not.toHaveBeenCalled();

    // 5 分钟警告窗口内再次转发广告贴纸 -> 升级处置，但仍绝不自动拉黑包名。
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "",
      isForwarded: true,
      stickerSetName: "ForwardedAdPack",
      stickerFileId: "fwd-sticker-2",
      stickerFileUniqueId: "u-fwd-2",
    }), 2_000);
    await runAdDetectBatch(2_000);

    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(verdict).toEqual({ isAd: true, reason: "转发贴纸广告" });
    expect(verdict.adStickerPacks).toBeUndefined();
    expect(verdict.adEmojiPacks).toBeUndefined();
  });

  test("本人直发贴纸携带引用文本时：二次归因复用已下载附件且不重复下载", async () => {
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return {
        isAd: true,
        reason: "直发广告贴纸",
        adStickerPacks: ["DirectAdPack"],
      };
    });

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      sampleQuote: "群友闲聊引文",
      stickerSetName: "DirectAdPack",
      stickerFileId: "direct-sticker-1",
      stickerFileUniqueId: "u-direct-1",
    }), 1_000);
    await runAdDetectBatch(1_000);

    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(classifyCalls).toHaveLength(2);
    expect(classifyCalls[0]?.text).toBe("1. 群友闲聊引文");
    expect(classifyCalls[0]?.attachments).toHaveLength(1);
    expect(classifyCalls[1]?.text).toBe("");
    expect(classifyCalls[1]?.attachments).toBeDefined();
    expect(classifyCalls[1]?.attachments?.[0]).toBe(classifyCalls[0]?.attachments?.[0]);
    expect(classifyCalls[1]?.stickerPackCandidates).toEqual(["DirectAdPack"]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(verdict).toEqual({
      isAd: true,
      reason: "直发广告贴纸",
      adStickerPacks: ["DirectAdPack"],
    });
  });

  test("同 fileUniqueId 先转发后直发时保留直发归属，不重复下载且二次归因可见该附件", async () => {
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return {
        isAd: (params.attachments?.length ?? 0) > 0,
        reason: "重复直发广告贴纸",
        adStickerPacks: ["SharedAdPack"],
      };
    });

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      isForwarded: true,
      stickerSetName: "SharedAdPack",
      stickerFileId: "shared-file-fwd",
      stickerFileUniqueId: "u-shared-1",
    }), 1_000);
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "",
      isForwarded: false,
      stickerSetName: "SharedAdPack",
      stickerFileId: "shared-file-direct",
      stickerFileUniqueId: "u-shared-1",
    }), 1_100);
    await runAdDetectBatch(1_100);

    expect(downloadTelegramFileFromMain).toHaveBeenCalledTimes(1);
    expect(classifyCalls).toHaveLength(2);
    expect(classifyCalls[1]?.attachments).toHaveLength(1);
    expect(classifyCalls[1]?.stickerPackCandidates).toEqual(["SharedAdPack"]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(verdict.adStickerPacks).toEqual(["SharedAdPack"]);
  });

  test("归因清洗剔除幻觉包名、非法格式与重复项；管理员与无包名贴纸遵循安全边界", async () => {
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-1", "RealEmojiPack"),
    ]);
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return {
        isAd: true,
        reason: "贴纸和表情推广",
        adStickerPacks: ["RealStickerPack", "HallucinatedPack", "invalid pack!", "RealStickerPack"],
        adEmojiPacks: ["RealEmojiPack", "FakeEmojiPack", "RealEmojiPack"],
      };
    });

    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "🔥",
      stickerSetName: "RealStickerPack",
      stickerFileId: "real-sticker-file",
      stickerFileUniqueId: "u-real-sticker",
      customEmojiIds: ["emoji-1"],
    }), 1_000);
    await runAdDetectBatch(1_000);

    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(verdict).toEqual({
      isAd: true,
      reason: "贴纸和表情推广",
      adStickerPacks: ["RealStickerPack"],
      adEmojiPacks: ["RealEmojiPack"],
    });

    // 无包名孤立贴纸（stickerSetName=undefined）：仍封禁发送者，但过滤掉任何幻觉包名。
    disposeAdSender.mockClear();
    enqueueAdCandidate(candidate({
      senderId: 8,
      messageId: 2,
      text: "",
      stickerSetName: undefined,
      stickerFileId: "orphan-sticker",
      stickerFileUniqueId: "u-orphan",
    }), 1_100);
    await runAdDetectBatch(1_100);

    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict: orphanVerdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(orphanVerdict).toEqual({ isAd: true, reason: "贴纸和表情推广" });
    expect(orphanVerdict.adStickerPacks).toBeUndefined();

    // 管理员发广告贴纸时豁免，绝不触发 disposeAdSender（不自动拉黑包）。
    disposeAdSender.mockClear();
    fetchedAdmins.set(-1001, new Set<number>([9]));
    enqueueAdCandidate(candidate({
      senderId: 9,
      messageId: 3,
      text: "",
      stickerSetName: "RealStickerPack",
      stickerFileId: "admin-sticker",
      stickerFileUniqueId: "u-admin-sticker",
    }), 1_200);
    await runAdDetectBatch(1_200);
    expect(disposeAdSender).not.toHaveBeenCalled();
  });

  test("未检媒体优先于已判上下文占位，超上限时按新到旧回填上下文并保持时间顺序、直发透传与混杂切片隔离", async () => {
    const taggedPng = (tag: number): Uint8Array => {
      const bytes: Uint8Array = new Uint8Array(PNG_BYTES.length + 1);
      bytes.set(PNG_BYTES, 0);
      bytes[PNG_BYTES.length] = tag;
      return bytes;
    };
    downloadTelegramFileFromMain.mockImplementation(async ({ fileId }): Promise<TelegramWorkerDownloadFileResult> => ({
      status: "ok",
      bytes: fileId === "ad-poster-new" ? taggedPng(99) : taggedPng(1),
    }));

    // 先发送满上限的已判正常图片上下文（seq 1..AD_DETECT_MAX_IMAGES_PER_BUNDLE）。
    for (let index: number = 0; index < AD_DETECT_MAX_IMAGES_PER_BUNDLE; index++) {
      enqueueAdCandidate(candidate({
        messageId: index + 1, imageFileId: `ctx-photo-${index}`, imageFileUniqueId: `u-ctx-photo-${index}`,
      }), 1_000 + index);
    }
    await runAdDetectBatch(1_500);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(AD_DETECT_MAX_IMAGES_PER_BUNDLE);

    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      const hasAdPoster: boolean = (params.attachments ?? []).some(
        (item): boolean => item.image.bytes[PNG_BYTES.length] === 99
      );
      return { isAd: hasAdPoster, reason: hasAdPoster ? "新海报广告" : "" };
    });

    // 再发送 1 张新未检广告海报：必须挤掉最旧的 ctx-photo-0，而非被旧上下文挤掉。
    enqueueAdCandidate(candidate({
      messageId: AD_DETECT_MAX_IMAGES_PER_BUNDLE + 1, imageFileId: "ad-poster-new", imageFileUniqueId: "u-ad-poster-new",
    }), 2_000);
    await runAdDetectBatch(2_000);

    const expectedFileIds: string[] = [
      ...Array.from(
        { length: AD_DETECT_MAX_IMAGES_PER_BUNDLE - 1 },
        (_unused: unknown, index: number): string => `ctx-photo-${index + 1}`
      ),
      "ad-poster-new",
    ];
    expect(downloadTelegramFileFromMain.mock.calls.map((call) => call[0].fileId)).toEqual(expectedFileIds);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments).toHaveLength(AD_DETECT_MAX_IMAGES_PER_BUNDLE);
    expect(classifyCalls[0]?.attachments?.at(-1)?.image.bytes[PNG_BYTES.length]).toBe(99);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    // 上下文直发贴纸与新未检转发贴纸同 fileUniqueId 去重时透传 isDirect；混入纯转发贴纸时 direct 切片仅保留直发项。
    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    disposeAdSender.mockClear();
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return { isAd: false, reason: "" };
    });
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 1, isForwarded: false,
      stickerSetName: "SharedCtxPack", stickerFileId: "ctx-direct-sticker", stickerFileUniqueId: "u-shared-ctx",
    }), 3_000);
    await runAdDetectBatch(3_000);
    expect(pendingAdBundle(-1001, 8)?.checkedSeq).toBe(1);

    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    classifyAdText.mockImplementation(async (params: ClassifyAdBundleOptions): Promise<AdVerdict> => {
      classifyCalls.push(params);
      return {
        isAd: (params.attachments?.length ?? 0) > 0,
        reason: "跨轮重复直发贴纸",
        adStickerPacks: ["SharedCtxPack", "ForwardedOnlyPack"],
      };
    });
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 2, isForwarded: true,
      stickerSetName: "SharedCtxPack", stickerFileId: "new-fwd-sticker", stickerFileUniqueId: "u-shared-ctx",
    }), 3_100);
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 3, isForwarded: true,
      stickerSetName: "ForwardedOnlyPack", stickerFileId: "fwd-only-sticker", stickerFileUniqueId: "u-fwd-only",
    }), 3_150);
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 4, isForwarded: false,
      imageFileId: "new-direct-photo", imageFileUniqueId: "u-new-direct-photo",
    }), 3_200);
    await runAdDetectBatch(3_200);

    expect(downloadTelegramFileFromMain.mock.calls.map((call) => call[0].fileId)).toEqual([
      "new-fwd-sticker",
      "fwd-only-sticker",
      "new-direct-photo",
    ]);
    expect(classifyCalls).toHaveLength(2);
    expect(classifyCalls[0]?.attachments?.map((item) => item.id)).toEqual(["sticker_1", "sticker_2", "photo_1"]);
    expect(classifyCalls[0]?.stickerPackCandidates).toEqual(["SharedCtxPack", "ForwardedOnlyPack"]);
    expect(classifyCalls[1]?.attachments?.map((item) => item.id)).toEqual(["sticker_1", "photo_1"]);
    expect(classifyCalls[1]?.stickerPackCandidates).toEqual(["SharedCtxPack"]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [DisposeAdSenderParams];
    expect(verdict.adStickerPacks).toEqual(["SharedCtxPack"]);
  });

  test("无未检文本且未产生任何未检附件时跳过上下文下载与冗余 AI 重检，但有未检文本或有效未检媒体时照常回填上下文", async () => {
    // 1. 先建立已判图片上下文（sender 7），再发无缩略图视频自定义表情 -> 下载前短路，不重下上下文图片也不调 AI。
    enqueueAdCandidate(candidate({
      senderId: 7, messageId: 1, imageFileId: "ctx-photo-1", imageFileUniqueId: "u-ctx-1",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifyCalls).toHaveLength(1);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(1);

    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-video-no-thumb", "NoThumbPack", {
        is_video: true, file_id: "webm-only", file_unique_id: "u-webm-only", thumbnail: undefined,
      }),
    ]);
    enqueueAdCandidate(candidate({ senderId: 7, messageId: 2, customEmojiIds: ["emoji-video-no-thumb"] }), 1_100);
    await runAdDetectBatch(1_100);

    expect(downloadTelegramFileFromMain).not.toHaveBeenCalled();
    expect(classifyCalls).toHaveLength(0);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(2);

    // 2. 未检图片下载失败而上下文图片下载成功时，因无未检附件且无未检文本，仍跳过冗余 AI 分类。
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 1, imageFileId: "ctx-photo-ok", imageFileUniqueId: "u-ctx-ok",
    }), 2_000);
    await runAdDetectBatch(2_000);
    expect(pendingAdBundle(-1001, 8)?.checkedSeq).toBe(1);

    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    downloadTelegramFileFromMain.mockImplementation(async ({ fileId }): Promise<TelegramWorkerDownloadFileResult> => (
      fileId === "unchecked-fail" ? { status: "downloadTimeout" } : { status: "ok", bytes: PNG_BYTES }
    ));
    enqueueAdCandidate(candidate({
      senderId: 8, messageId: 2, imageFileId: "unchecked-fail", imageFileUniqueId: "u-unchecked-fail",
    }), 2_100);
    await runAdDetectBatch(2_100);

    expect(classifyCalls).toHaveLength(0);
    expect(pendingAdBundle(-1001, 8)?.checkedSeq).toBe(2);

    // 3. 上下文带自定义表情：无未检文本但有有效未检图片/表情时回填上下文表情；后续新增未检文本时仍附带上下文媒体。
    downloadTelegramFileFromMain.mockImplementation(async (): Promise<TelegramWorkerDownloadFileResult> => ({
      status: "ok", bytes: PNG_BYTES,
    }));
    getCustomEmojiStickers.mockImplementation(async (ids: readonly string[]): Promise<Sticker[]> =>
      ids.map((id: string): Sticker => emojiSticker(id, `Pack_${id.replace(/-/g, "_")}`)));
    enqueueAdCandidate(candidate({ senderId: 9, messageId: 1, text: "🔥", customEmojiIds: ["emoji-ctx"] }), 3_000);
    await runAdDetectBatch(3_000);

    downloadTelegramFileFromMain.mockClear();
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({
      senderId: 9, messageId: 2, imageFileId: "photo-unchecked-2", imageFileUniqueId: "u-photo-unchecked-2",
    }), 3_100);
    await runAdDetectBatch(3_100);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments?.map((item) => item.id)).toEqual(["custom_emoji_1", "photo_1"]);

    // 未检条目携带新自定义表情且上下文含已有自定义表情时，合并两边元数据并按时间顺序输出。
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({ senderId: 9, messageId: 3, customEmojiIds: ["emoji-new-3"] }), 3_200);
    await runAdDetectBatch(3_200);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments?.map((item) => item.id)).toEqual([
      "custom_emoji_1", "photo_1", "custom_emoji_2",
    ]);

    // 仅新增未检文本时，上下文媒体照常参与本次多模态分类。
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({ senderId: 9, messageId: 4, text: "补充一句文字" }), 3_300);
    await runAdDetectBatch(3_300);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.text).toContain("补充一句文字");
    expect(classifyCalls[0]?.attachments?.map((item) => item.id)).toEqual([
      "custom_emoji_1", "photo_1", "custom_emoji_2",
    ]);
  });

  test("单束累积字节受 MEDIA_MAX_DOWNLOAD_BYTES 约束：优先保留未检附件，超限附件记 warning 并跳过", async () => {
    const sizedPng = (byteLength: number, tag: number): Uint8Array => {
      const bytes: Uint8Array = new Uint8Array(byteLength);
      bytes.set(PNG_BYTES, 0);
      bytes[PNG_BYTES.length] = tag;
      return bytes;
    };
    const sixtyPercent: number = Math.floor(MEDIA_MAX_DOWNLOAD_BYTES * 0.6);
    const thirtyPercent: number = Math.floor(MEDIA_MAX_DOWNLOAD_BYTES * 0.3);
    const bytesByFileId: Readonly<Record<string, Uint8Array>> = {
      "ctx-small": sizedPng(thirtyPercent, 1),
      "ctx-giant": sizedPng(sixtyPercent, 2),
      "unchecked-ad": sizedPng(sixtyPercent, 3),
      "burst-1": sizedPng(sixtyPercent, 4),
      "burst-2": sizedPng(sixtyPercent, 5),
      "burst-3": sizedPng(sixtyPercent, 6),
    };
    downloadTelegramFileFromMain.mockImplementation(async ({ fileId }): Promise<TelegramWorkerDownloadFileResult> => ({
      status: "ok", bytes: bytesByFileId[fileId] ?? PNG_BYTES,
    }));

    // 1. 先积累 30% + 60% = 90% 的上下文图片，均在单束字节预算内。
    enqueueAdCandidate(candidate({ senderId: 7, messageId: 1, imageFileId: "ctx-small", imageFileUniqueId: "u-ctx-small" }), 1_000);
    enqueueAdCandidate(candidate({ senderId: 7, messageId: 2, imageFileId: "ctx-giant", imageFileUniqueId: "u-ctx-giant" }), 1_050);
    await runAdDetectBatch(1_050);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(2);

    // 2. 新未检 60% 广告图到来：先占 60% 预算，跳过 60% 旧上下文（120% > 100%），再纳入 30% 旧上下文（90% <= 100%）。
    warnLogs.length = 0;
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({ senderId: 7, messageId: 3, imageFileId: "unchecked-ad", imageFileUniqueId: "u-unchecked-ad" }), 1_100);
    await runAdDetectBatch(1_100);

    expect(classifyCalls).toHaveLength(1);
    const selectedTags: number[] = (classifyCalls[0]?.attachments ?? []).map(
      (item): number => item.image.bytes[PNG_BYTES.length] ?? -1
    );
    expect(selectedTags).toEqual([1, 3]);
    const totalBytes: number = (classifyCalls[0]?.attachments ?? []).reduce(
      (sum: number, item): number => sum + item.image.bytes.byteLength, 0
    );
    expect(totalBytes).toBeLessThanOrEqual(MEDIA_MAX_DOWNLOAD_BYTES);
    expect(warnLogs.filter((entry): boolean =>
      String(entry[0]).includes("exceeding cumulative bundle size limit")
    )).toHaveLength(1);

    // 3. 单轮突发 3 张各 60% 的未检图片：只装入首张，后两张因累积超限记 warning 并跳过。
    warnLogs.length = 0;
    classifyCalls.length = 0;
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 1, imageFileId: "burst-1", imageFileUniqueId: "u-burst-1" }), 2_000);
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 2, imageFileId: "burst-2", imageFileUniqueId: "u-burst-2" }), 2_010);
    enqueueAdCandidate(candidate({ senderId: 8, messageId: 3, imageFileId: "burst-3", imageFileUniqueId: "u-burst-3" }), 2_020);
    await runAdDetectBatch(2_020);

    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.attachments).toHaveLength(1);
    expect(classifyCalls[0]?.attachments?.[0]?.image.bytes[PNG_BYTES.length]).toBe(4);
    expect(warnLogs.filter((entry): boolean =>
      String(entry[0]).includes("exceeding cumulative bundle size limit")
    )).toHaveLength(2);
  });
});
