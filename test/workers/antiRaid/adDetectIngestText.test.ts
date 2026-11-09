import { beforeEach, describe, expect, test } from "bun:test";
import type { Sticker } from "grammy/types";
import { defaultAdSampleConfigCache } from "../../../packages/cache/perThread/config";
import type { AdVerdict, AdVerdictTrueEvent } from "../../../packages/types/antiRaid/adDetect";
import {
  candidate,
  classifiedTexts,
  classifyAdText,
  disposeAdSender,
  errorLogs,
  getCustomEmojiStickers,
  resetAdDetectQueueHarness,
  warnReferencedAdSender,
} from "../../helpers/adDetectQueueHarness";
import { grammyApiError } from "../../helpers/grammyError";

const {
  enqueueAdCandidate,
  runAdDetectBatch,
  stopAdDetectQueue,
} = await import("../../../packages/workers/antiRaid/adDetect/queue");
const { formatAdBundleText } = await import("../../../packages/workers/antiRaid/adDetect/bundle");
const {
  adDetectQueue,
  adVerdictTruePublishHolder,
  customEmojiSetNames,
} = await import("../../../packages/cache/workers/antiRaid/adDetect");
const {
  AD_DETECT_BUNDLE_MAX_CHARS,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_LINK_URL_MAX_CHARS,
  AD_DETECT_MAX_LINK_URLS,
  AD_DETECT_MAX_MESSAGES_PER_SENDER,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES,
  AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX,
  AD_SAMPLE_CONTEXT_MAX_CHARS,
  adEmojiBlacklistReason,
  adStickerBlacklistReason,
} = await import("../../../packages/consts/antiRaid/adDetect");
const { TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS } =
  await import("../../../packages/consts/telegram");

const { pendingAdBundle } =
  await import("../../../packages/workers/antiRaid/adDetect/queueState");
beforeEach((): void => resetAdDetectQueueHarness(stopAdDetectQueue));

/**
 * 构造 getCustomEmojiStickers 返回的自定义表情贴纸夹具。
 * @param id 自定义表情 ID。
 * @param setName 所属表情包 short name；不属于任何表情包时为 undefined。
 * @returns 自定义表情贴纸对象。
 */
function emojiSticker(id: string, setName: string | undefined): Sticker {
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
  };
}

describe("入队时的送检文本整形", () => {
  test("拼串只负责编号，取舍由 selectAdBundleEntries 定完再交过来", () => {
    expect(formatAdBundleText([
      {
        messageId: 1,
        seq: 1,
        text: "第一条",
        directText: "第一条",
        receivedAt: 1,
        withinReferencedWarning: false,
        stickerSetName: undefined,
        customEmojiIds: undefined,
        quote: undefined,
        replyTo: undefined,
      },
      {
        messageId: 2,
        seq: 2,
        text: "第二条",
        directText: "第二条",
        receivedAt: 2,
        withinReferencedWarning: false,
        stickerSetName: undefined,
        customEmojiIds: undefined,
        quote: undefined,
        replyTo: undefined,
      },
    ])).toBe("1. 第一条\n2. 第二条");
    expect(formatAdBundleText([])).toBe("");
  });

  test("送检预算装不下时按序判定，没送审的条目不算判过", async () => {
    // 一条广告后面跟一串灌水撑爆 AD_DETECT_BUNDLE_MAX_CHARS。水位只推到这一拍真正送检的最后一条，从最旧一条起按序取。
    const filler: string = "填".repeat(AD_DETECT_MESSAGE_MAX_CHARS);
    const fillerCount: number = Math.ceil(AD_DETECT_BUNDLE_MAX_CHARS / AD_DETECT_MESSAGE_MAX_CHARS) + 1;
    enqueueAdCandidate(candidate({ messageId: 1, text: "日入过千 加V xxx996" }), 1_000);
    for (let index: number = 0; index < fillerCount; index++) {
      enqueueAdCandidate(candidate({ messageId: index + 2, text: filler }), 1_000 + index);
    }

    await runAdDetectBatch(1_000);
    const bundle = pendingAdBundle(-1001, 7)!;
    // 第一拍读到的是最旧那批（广告在其中），不是被预算挤剩的尾巴。
    expect(classifiedTexts[0]).toContain("日入过千");
    expect(bundle.checkedSeq).toBeLessThan(fillerCount + 1);
    expect(bundle.entries.some((entry) => entry.seq > bundle.checkedSeq)).toBe(true);

    // 剩下的未判条目在本批结算时重排。
    expect(adDetectQueue.size).toBe(1);
    await runAdDetectBatch(1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1);
    expect(bundle.checkedSeq).toBe(fillerCount + 1);
  });

  test("引用与回复接进送检文本一起判定：广告主流形态是「编辑旧消息 + 回复/引用顶上来」，" +
    "广告正文永远不在新消息的 text 里", async () => {
    // quote 与 replyTo 完全重合（引用的正是所回复消息的片段）时只接一遍。
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "这种广告真烦",
      sampleQuote: "日入过千 加V xxx996",
      sampleReplyTo: "日入过千 加V xxx996",
    }), 1_000);

    const entry = pendingAdBundle(-1001, 7)!.entries[0]!;
    expect(entry.text).toBe("这种广告真烦 日入过千 加V xxx996");
    expect(entry.directText).toBe("这种广告真烦");
    // 样本侧留一份没并进正文的原样。
    expect(entry.quote).toBe("日入过千 加V xxx996");
    expect(entry.replyTo).toBe("日入过千 加V xxx996");

    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 这种广告真烦 日入过千 加V xxx996"]);
  });

  test("同一段引文整串只接一份：拆开发的碎片才凑得进同一份清单，不被重复引文吃掉预算", async () => {
    // 广告号把话术拆成三条、每条都回复同一条（已被编辑成广告的）消息。
    const replyTo: string = "日".repeat(AD_SAMPLE_CONTEXT_MAX_CHARS);
    for (const [index, own] of ["加我", "微 信", "xxx996"].entries()) {
      enqueueAdCandidate(candidate({ messageId: index + 1, text: own, sampleReplyTo: replyTo }), 1_000);
    }

    const entries = pendingAdBundle(-1001, 7)!.entries;
    expect(entries.map((entry): string => entry.text)).toEqual([`加我 ${replyTo}`, "微 信", "xxx996"]);
    // 样本侧每条都留一份原样。
    expect(entries.map((entry): string | undefined => entry.replyTo)).toEqual([replyTo, replyTo, replyTo]);

    await runAdDetectBatch(1_000);
    // 三个碎片与那段引文一起进同一次判定。
    expect(classifiedTexts).toEqual([`1. 加我 ${replyTo}\n2. 微 信\n3. xxx996`]);
  });

  test("认领者被裁掉后引文重新认领：串里再没人带着它时，下一条候选自己接一份", async () => {
    const replyTo: string = "日入过千 加V xxx996";
    enqueueAdCandidate(candidate({ messageId: 1, text: "看这个", sampleReplyTo: replyTo }), 1_000);
    await runAdDetectBatch(1_000);

    // 第一条判过又出了去重窗口，pruneConsumedContext 把它连引文一起裁掉。
    const later: number = 1_000 + AD_DETECT_JUDGED_RETENTION_WINDOW_MS + 1;
    enqueueAdCandidate(candidate({ messageId: 2, text: "再看这个", sampleReplyTo: replyTo }), later);

    const entries = pendingAdBundle(-1001, 7)!.entries;
    expect(entries.map((entry): string => entry.text)).toEqual([`再看这个 ${replyTo}`]);
  });

  test("引用段与被回复原文不同时两段都接，且不带「引用：」这类可被伪造的系统措辞", async () => {
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "真的假的",
      sampleQuote: "日入过千",
      sampleReplyTo: "加V xxx996",
    }), 1_000);

    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 真的假的 日入过千 加V xxx996"]);
  });

  test("上下文接在正文截断之后，几百字废话顶不掉引文", async () => {
    // 上下文接在正文按 AD_DETECT_MESSAGE_MAX_CHARS 截断之后，填充文本顶不掉引文。
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "废".repeat(AD_DETECT_MESSAGE_MAX_CHARS + 200),
      sampleQuote: "日入过千 加V xxx996",
    }), 1_000);

    const entry = pendingAdBundle(-1001, 7)!.entries[0]!;
    expect(entry.text).toBe(`${"废".repeat(AD_DETECT_MESSAGE_MAX_CHARS)} 日入过千 加V xxx996`);
  });

  test("落地页 URL 有独立配额，填充文本顶不掉它", () => {
    // 正文按 AD_DETECT_MESSAGE_MAX_CHARS 从头保留，URL 接在截断之后，不共用额度。
    enqueueAdCandidate(candidate({
      text: "填".repeat(AD_DETECT_MESSAGE_MAX_CHARS + 200),
      linkUrls: ["https://t.me/spamchannel"],
    }), 1_000);
    const text: string = pendingAdBundle(-1001, 7)!.entries[0]!.text;
    expect(text.endsWith(" https://t.me/spamchannel")).toBe(true);
    expect(text).toHaveLength(AD_DETECT_MESSAGE_MAX_CHARS + 1 + "https://t.me/spamchannel".length);
  });

  test("URL 段自己也有上界：条数与单条长度在 Worker 侧再收一次", () => {
    enqueueAdCandidate(candidate({
      text: "点这里",
      linkUrls: [
        ...Array.from({ length: AD_DETECT_MAX_LINK_URLS + 3 }, (_unused, index: number) => `https://spam.example/${index}`),
        `https://spam.example/${"x".repeat(AD_DETECT_LINK_URL_MAX_CHARS)}`,
      ],
    }), 1_000);
    const parts: string[] = pendingAdBundle(-1001, 7)!.entries[0]!.text.split(" ");
    expect(parts).toHaveLength(AD_DETECT_MAX_LINK_URLS + 1);
    for (const part of parts.slice(1)) expect(part.length).toBeLessThanOrEqual(AD_DETECT_LINK_URL_MAX_CHARS);
  });

  test("单 key 条数上限挤掉从没判过的正文时记一行日志，每个发送者只记一次", () => {
    for (let index: number = 0; index < AD_DETECT_MAX_MESSAGES_PER_SENDER + 3; index++) {
      enqueueAdCandidate(candidate({ messageId: index + 1, text: `广告 ${index}` }), 1_000);
    }

    const dropped: string[] = errorLogs.filter((line: string): boolean =>
      line.includes("dropped never-judged message text")
    );
    // 丢的正文不会进入分类器；每个发送者只记一次，之后挤掉的不再逐条记。
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain("sender 7");
    expect(pendingAdBundle(-1001, 7)!.pendingDeleteIds).toHaveLength(3);
  });

  test("sticker_black_list 快路径命中时跳过自定义表情查询与 AI 检测，即使带引用也直接走 block", async () => {
    const verdictEvents: AdVerdictTrueEvent[] = [];
    adVerdictTruePublishHolder.current = (event: AdVerdictTrueEvent): void => {
      verdictEvents.push(event);
    };
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: ["SpamStickerPack"],
      emojiBlackList: ["SpamEmojiPack"],
    };
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      stickerSetName: "SpamStickerPack",
      customEmojiIds: ["emoji-1"],
      sampleQuote: "引用文本",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).not.toHaveBeenCalled();
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(warnReferencedAdSender).not.toHaveBeenCalled();
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [{ verdict: AdVerdict }];
    expect(verdict).toEqual({
      isAd: true,
      reason: adStickerBlacklistReason("SpamStickerPack"),
    });
    expect(verdictEvents).toEqual([{
      type: "adVerdictTrue",
      chatId: -1001,
      senderId: 7,
    }]);
  });

  test("sticker 未命中后检测 emoji_black_list，命中时跳过 AI 检测并直接走 block", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: ["OtherStickerPack"],
      emojiBlackList: ["SpamEmojiPack"],
    };
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => ([
      {
        file_id: "f-1",
        file_unique_id: "u-1",
        type: "custom_emoji",
        width: 100,
        height: 100,
        is_animated: false,
        is_video: false,
        custom_emoji_id: "emoji-1",
        set_name: "SpamEmojiPack",
      },
    ]));
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "🔥",
      customEmojiIds: ["emoji-1"],
      sampleReplyTo: "回复文本",
    }), 1_000);

    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
    expect(getCustomEmojiStickers).toHaveBeenCalledWith(["emoji-1"]);
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(warnReferencedAdSender).not.toHaveBeenCalled();
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [{ verdict: AdVerdict }];
    expect(verdict).toEqual({
      isAd: true,
      reason: adEmojiBlacklistReason("SpamEmojiPack"),
    });
  });

  test("黑名单均未命中时：纯贴纸不调 AI 并推进水位，含正文的消息继续走 AI 检测", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: ["SpamStickerPack"],
      emojiBlackList: ["SpamEmojiPack"],
    };
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "",
      firstName: "Alice",
      stickerSetName: "CleanStickerPack",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(1);

    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => ([
      {
        file_id: "f-2",
        file_unique_id: "u-2",
        type: "custom_emoji",
        width: 100,
        height: 100,
        is_animated: false,
        is_video: false,
        custom_emoji_id: "emoji-2",
        set_name: "CleanEmojiPack",
      },
    ]));
    classifyAdText.mockImplementationOnce(async (): Promise<AdVerdict> => ({
      isAd: true,
      reason: "AI 命中引流",
    }));
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "加我微信",
      firstName: "Alice",
      customEmojiIds: ["emoji-2"],
    }), 1_100);
    await runAdDetectBatch(1_100);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(classifiedTexts).toEqual(["1. Alice 加我微信"]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("已有已判文本上下文时，后续未命中黑名单的纯贴纸或重复引文贴纸不重复触发 AI 分类", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: ["SpamStickerPack"],
      emojiBlackList: ["SpamEmojiPack"],
    };
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "早上好",
      firstName: "Alice",
      sampleReplyTo: "旧引文",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(1);

    // 紧接着发一张干净的纯贴纸，以及一张回复同一条已认领引文的干净贴纸：两者都只过贴纸快路径，不重跑 AI。
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "",
      firstName: "Alice",
      stickerSetName: "CleanStickerPack",
    }), 1_100);
    enqueueAdCandidate(candidate({
      messageId: 3,
      text: "",
      firstName: "Alice",
      stickerSetName: "CleanStickerPack",
      sampleReplyTo: "旧引文",
    }), 1_200);
    await runAdDetectBatch(1_200);

    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(3);
  });

  test("跨条目自定义表情去重后按 TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS 分批查询，后一批命中黑名单同样直接处置", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    const firstBatchIds: string[] = Array.from(
      { length: TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS - 1 },
      (_unused: unknown, index: number): string => `emoji-${index}`
    );
    getCustomEmojiStickers.mockImplementation(async (ids: readonly string[]): Promise<Sticker[]> =>
      ids.map((id: string): Sticker => emojiSticker(id, id === "emoji-tail-2" ? "SpamEmojiPack" : "CleanEmojiPack")));
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "第一条",
      customEmojiIds: firstBatchIds,
    }), 1_000);
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "第二条",
      customEmojiIds: ["emoji-0", "emoji-tail-1", "emoji-tail-2"],
    }), 1_010);

    await runAdDetectBatch(1_010);

    const queriedBatches: string[][] = getCustomEmojiStickers.mock.calls.map(
      (call: unknown[]): string[] => call[0] as string[]
    );
    expect(queriedBatches.map((batch: string[]): number => batch.length))
      .toEqual([TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS, 1]);
    expect(queriedBatches[0]?.at(-1)).toBe("emoji-tail-1");
    expect(queriedBatches[1]).toEqual(["emoji-tail-2"]);
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    const [{ verdict }] = disposeAdSender.mock.calls[0] as [{ verdict: AdVerdict }];
    expect(verdict).toEqual({ isAd: true, reason: adEmojiBlacklistReason("SpamEmojiPack") });
  });

  test("查询失败时各批共用 AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES 次重试，预算内恢复则照常核对", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    for (let attempt: number = 0; attempt < AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES; attempt++) {
      getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => {
        throw new Error("network timeout");
      });
    }
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-spam", "SpamEmojiPack"),
    ]);
    enqueueAdCandidate(candidate({ text: "🔥", customEmojiIds: ["emoji-spam"] }), 1_000);

    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES + 1);
    expect(errorLogs).toEqual([]);
    expect(classifyAdText).not.toHaveBeenCalled();
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
  });

  test("重试预算用尽后放弃本轮表情核对：记日志、不写缓存、回退 AI 检测", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    getCustomEmojiStickers.mockImplementation(async (): Promise<Sticker[]> => {
      throw new Error("network timeout");
    });
    enqueueAdCandidate(candidate({ text: "第一条", customEmojiIds: ["emoji-spam"] }), 1_000);

    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES + 1);
    expect(errorLogs.some((line: string): boolean =>
      line.includes("failed to query custom emoji stickers") &&
      line.includes(`(${AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES} retries used)`)
    )).toBe(true);
    expect(customEmojiSetNames.size).toBe(0);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(pendingAdBundle(-1001, 7)?.checkedSeq).toBe(1);
  });

  test("Bot API 以 4xx 拒绝查询时不重试，直接放弃本轮表情核对", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    getCustomEmojiStickers.mockImplementation(async (): Promise<Sticker[]> => {
      throw grammyApiError(400, "Bad Request: invalid custom emoji identifier");
    });
    enqueueAdCandidate(candidate({ text: "第一条", customEmojiIds: ["emoji-bad"] }), 1_000);

    await runAdDetectBatch(1_000);

    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(1);
    expect(errorLogs.some((line: string): boolean => line.includes("(0 retries used)"))).toBe(true);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
  });

  test("自定义表情所属包写入 LRU：已查过的 ID（含无所属包）不再查询，缓存命中黑名单直接处置", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-clean", "CleanEmojiPack"),
      emojiSticker("emoji-loose", undefined),
    ]);
    enqueueAdCandidate(candidate({
      messageId: 1,
      text: "🙂🙂",
      customEmojiIds: ["emoji-clean", "emoji-loose"],
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(customEmojiSetNames.peek("emoji-clean")).toBe("CleanEmojiPack");
    expect(customEmojiSetNames.peek("emoji-loose")).toBeNull();

    getCustomEmojiStickers.mockImplementationOnce(async (): Promise<Sticker[]> => [
      emojiSticker("emoji-spam", "SpamEmojiPack"),
    ]);
    enqueueAdCandidate(candidate({
      messageId: 2,
      text: "🙂🙂🔥",
      customEmojiIds: ["emoji-clean", "emoji-loose", "emoji-spam"],
    }), 1_100);
    await runAdDetectBatch(1_100);
    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(2);
    expect(getCustomEmojiStickers.mock.calls[1]).toEqual([["emoji-spam"]]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);

    enqueueAdCandidate(candidate({
      senderId: 8,
      messageId: 3,
      text: "🔥",
      customEmojiIds: ["emoji-spam"],
    }), 1_200);
    await runAdDetectBatch(1_200);
    expect(getCustomEmojiStickers).toHaveBeenCalledTimes(2);
    expect(classifyAdText).toHaveBeenCalledTimes(1);
    expect(disposeAdSender).toHaveBeenCalledTimes(2);
    const [{ verdict }] = disposeAdSender.mock.calls[1] as [{ verdict: AdVerdict }];
    expect(verdict).toEqual({ isAd: true, reason: adEmojiBlacklistReason("SpamEmojiPack") });

    stopAdDetectQueue();
    expect(customEmojiSetNames.size).toBe(0);
  });

  test("自定义表情所属包缓存满 AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX 条后淘汰最久未用的 ID", async () => {
    defaultAdSampleConfigCache.current = {
      samples: [],
      stickerBlackList: [],
      emojiBlackList: ["SpamEmojiPack"],
    };
    getCustomEmojiStickers.mockImplementation(async (ids: readonly string[]): Promise<Sticker[]> =>
      ids.map((id: string): Sticker => emojiSticker(id, "CleanEmojiPack")));
    for (let index: number = 0; index <= AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX; index++) {
      enqueueAdCandidate(candidate({
        senderId: 100 + index,
        messageId: index + 1,
        text: "🙂",
        customEmojiIds: [`emoji-${index}`],
      }), 1_000);
    }
    while (adDetectQueue.size > 0) await runAdDetectBatch(1_000);

    expect(customEmojiSetNames.size).toBe(AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX);
    expect(customEmojiSetNames.has("emoji-0")).toBe(false);
    expect(customEmojiSetNames.has(`emoji-${AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX}`)).toBe(true);
  });
});
