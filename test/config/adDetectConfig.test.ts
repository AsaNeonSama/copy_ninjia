import { describe, expect, test } from "bun:test";
import { getAdDetectConfig, loadAdDetectConfig, parseAdDetectConfig } from "../../packages/config/adDetectConfig";
import {
  AD_SAMPLE_MAX_CHARS,
  MAX_CONFIGURED_AD_BLACKLIST_PACKS,
  MAX_CONFIGURED_AD_SAMPLES,
} from "../../packages/consts/antiRaid/adDetect";
import {
  DURATION_UNIT_MS,
  MUTE_MAX_DURATION_MS,
  MUTE_MIN_DURATION_MS,
} from "../../packages/consts/commands";
import type { AdDetectConfig, AdDetectPunishment } from "../../packages/types/config";

/** 夹具：移出并写入永久黑名单的处罚段。 */
const GLOBAL_BLOCK_INPUT: Readonly<Record<string, unknown>> = {
  kick: { block: true, block_scope: "global" },
};

/** 顶层形态不符时的期望形态描述。 */
const TOP_LEVEL_EXPECTED: string =
  "exactly { punishment: object, samples: string[], sticker_black_list: string[], emoji_black_list: string[] }";

/** punishment 不是恰好含 mute 或 kick 其一时的期望形态描述。 */
const PUNISHMENT_EXPECTED: string = "an object with exactly one of mute or kick";

/**
 * 只换 punishment 段、其余字段取空表后解析。
 * @param punishment 待解析的 punishment 原始值。
 * @returns 解析出的处罚设置。
 */
function parsePunishmentInput(punishment: unknown): AdDetectPunishment {
  return parseAdDetectConfig({
    punishment,
    samples: [],
    sticker_black_list: [],
    emoji_black_list: [],
  }).punishment;
}

describe("ad_detect.json", () => {
  test("顶层包含 punishment、samples、sticker_black_list 与 emoji_black_list，空白规范化后保留", async () => {
    // 示例按行拼进提示词；带换行的示例被折叠成单行，包名去掉首尾空白。
    expect(parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [" 加  微信\n拉群 ", "USDT 承兑"],
      sticker_black_list: ["  SpamStickerPack_1  "],
      emoji_black_list: ["  SpamEmojiPack_1  "],
    })).toEqual({
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["加 微信 拉群", "USDT 承兑"],
      stickerBlackList: ["SpamStickerPack_1"],
      emojiBlackList: ["SpamEmojiPack_1"],
    });
    expect((await loadAdDetectConfig()).samples.length).toBeGreaterThan(0);
  });

  test("mute 解析出禁言时长或永久，kick 解析出封禁范围或只踢不封", () => {
    expect(parsePunishmentInput({ mute: { permanent: false, duration: " 30m " } }))
      .toEqual({ kind: "mute", durationMs: 30 * DURATION_UNIT_MS.m });
    expect(parsePunishmentInput({ mute: { permanent: true } }))
      .toEqual({ kind: "mute", durationMs: null });
    expect(parsePunishmentInput({ kick: { block: false } }))
      .toEqual({ kind: "kick", blockScope: null });
    expect(parsePunishmentInput({ kick: { block: true, block_scope: " chat " } }))
      .toEqual({ kind: "kick", blockScope: "chat" });
    // 禁言时长上下界取 /mute 同一区间，边界值本身合法。
    expect(parsePunishmentInput({
      mute: { permanent: false, duration: `${MUTE_MIN_DURATION_MS / DURATION_UNIT_MS.m}m` },
    })).toEqual({ kind: "mute", durationMs: MUTE_MIN_DURATION_MS });
    expect(parsePunishmentInput({
      mute: { permanent: false, duration: `${MUTE_MAX_DURATION_MS / DURATION_UNIT_MS.d}d` },
    })).toEqual({ kind: "mute", durationMs: MUTE_MAX_DURATION_MS });
  });

  test("mute 与 kick 互斥：同时出现、都缺省、多余键或非对象一律拒绝", () => {
    const rejects = (punishment: unknown): void => {
      expect(() => parsePunishmentInput(punishment)).toThrow(`$.punishment must be ${PUNISHMENT_EXPECTED}.`);
    };
    expect(() => parseAdDetectConfig({ samples: [], sticker_black_list: [], emoji_black_list: [] }))
      .toThrow(TOP_LEVEL_EXPECTED);
    rejects({ mute: { permanent: true }, kick: { block: false } });
    rejects({});
    rejects([]);
    rejects(null);
    rejects({ kick: { block: false }, extra: true });
    // `level` 等未列出的键同样拒绝。
    rejects({ level: 2, kick: { block: true, block_scope: "global" } });
  });

  test("拒绝类型不符、取值越界、枚举非法与互斥冲突的 mute、kick 设置", () => {
    const rejects = (punishment: unknown, fieldPath: string, expected: string): void => {
      expect(() => parsePunishmentInput(punishment)).toThrow(`${fieldPath} must be ${expected}.`);
    };
    const muteExpected: string = "an object { permanent: boolean, duration?: string }";
    rejects({ mute: [] }, "$.punishment.mute", muteExpected);
    rejects({ mute: { permanent: true, extra: 1 } }, "$.punishment.mute", muteExpected);
    rejects({ mute: { permanent: "true" } }, "$.punishment.mute.permanent", "a boolean");
    rejects({ mute: { duration: "1d" } }, "$.punishment.mute.permanent", "a boolean");
    rejects({ mute: { permanent: true, duration: "1d" } }, "$.punishment.mute.duration", "absent when permanent is true");
    const durationExpected: string =
      `a duration such as "30m", "12h" or "7d" between ${MUTE_MIN_DURATION_MS / DURATION_UNIT_MS.m}m ` +
      `and ${MUTE_MAX_DURATION_MS / DURATION_UNIT_MS.d}d when permanent is false`;
    for (const duration of [undefined, "", "   ", "30", "0m", "1.5h", "1w", 30, `${MUTE_MAX_DURATION_MS / DURATION_UNIT_MS.d + 1}d`]) {
      rejects({ mute: { permanent: false, duration } }, "$.punishment.mute.duration", durationExpected);
    }

    const kickExpected: string = "an object { block: boolean, block_scope?: \"chat\" | \"global\" }";
    rejects({ kick: "global" }, "$.punishment.kick", kickExpected);
    rejects({ kick: { block: false, extra: 1 } }, "$.punishment.kick", kickExpected);
    rejects({ kick: { block: 1 } }, "$.punishment.kick.block", "a boolean");
    rejects({ kick: { block: false, block_scope: "chat" } }, "$.punishment.kick.block_scope", "absent when block is false");
    for (const blockScope of [undefined, "", "all", "Global", 1]) {
      rejects({ kick: { block: true, block_scope: blockScope } }, "$.punishment.kick.block_scope", "\"chat\" or \"global\" when block is true");
    }
  });

  test("拒绝缺失或多余字段、非数组、非字符串、空白、非法包名与重复条目", () => {
    expect(() => parseAdDetectConfig(["旧数组结构"])).toThrow(
      TOP_LEVEL_EXPECTED
    );
    expect(() => parseAdDetectConfig({ samples: [] })).toThrow(
      TOP_LEVEL_EXPECTED
    );
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: [],
      emoji_black_list: [],
      extra: [],
    })).toThrow(TOP_LEVEL_EXPECTED);
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [42],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("a non-empty string");
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: ["   "],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("a non-empty string");
    // 折叠空白之后才判重：同一条广告多写两个空格按同一条处理。
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: ["加 微信", "加  微信"],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("unique after whitespace normalization");

    // 贴纸与表情黑名单必须为合法 Telegram short name 且唯一。
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: ["bad pack name"],
      emoji_black_list: [],
    })).toThrow("a valid Telegram sticker pack short name");
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: ["Pack_1", " Pack_1 "],
      emoji_black_list: [],
    })).toThrow("unique");
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: [],
      emoji_black_list: ["invalid-hyphen"],
    })).toThrow("a valid Telegram sticker pack short name");
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: [],
      emoji_black_list: ["Emoji_1", "Emoji_1"],
    })).toThrow("unique");
  });

  test("samples、sticker_black_list 与 emoji_black_list 条数及单条长度都有上界", () => {
    const maximum: string[] = Array.from({ length: MAX_CONFIGURED_AD_SAMPLES }, (_, index) => `sample_${index}`);
    expect(parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: maximum,
      sticker_black_list: [],
      emoji_black_list: [],
    }).samples).toHaveLength(MAX_CONFIGURED_AD_SAMPLES);
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [...maximum, "overflow"],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_SAMPLES} entries`);
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: ["x".repeat(AD_SAMPLE_MAX_CHARS + 1)],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow(`no longer than ${AD_SAMPLE_MAX_CHARS} characters`);

    const maxPacks: string[] = Array.from(
      { length: MAX_CONFIGURED_AD_BLACKLIST_PACKS },
      (_, index) => `Pack_${index}`
    );
    expect(parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: maxPacks,
      emoji_black_list: maxPacks,
    }).stickerBlackList).toHaveLength(MAX_CONFIGURED_AD_BLACKLIST_PACKS);
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: [...maxPacks, "Overflow_Pack"],
      emoji_black_list: [],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_BLACKLIST_PACKS} entries`);
    expect(() => parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: [],
      sticker_black_list: [],
      emoji_black_list: [...maxPacks, "Overflow_Pack"],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_BLACKLIST_PACKS} entries`);
  });

  test("解析结果只读，调用方改不动共享单例", () => {
    const probe: AdDetectConfig = parseAdDetectConfig({
      punishment: GLOBAL_BLOCK_INPUT,
      samples: ["加微信"],
      sticker_black_list: ["BadSticker"],
      emoji_black_list: ["BadEmoji"],
    });
    expect(probe).toEqual({
      punishment: { kind: "kick", blockScope: "global" },
      samples: ["加微信"],
      stickerBlackList: ["BadSticker"],
      emojiBlackList: ["BadEmoji"],
    });
    const assertCompileTimeReadonly = (): void => {
      // @ts-expect-error 顶层字段只读
      probe.samples = [];
      // @ts-expect-error 处罚设置只读
      probe.punishment = { kind: "mute", durationMs: null };
      // @ts-expect-error 处罚种类不允许就地改写
      probe.punishment.kind = "mute";
      // @ts-expect-error 示例表不允许就地追加
      probe.samples.push("x");
      // @ts-expect-error 贴纸黑名单不允许就地追加
      probe.stickerBlackList.push("x");
      // @ts-expect-error 表情黑名单不允许就地追加
      probe.emojiBlackList.push("x");
    };
    void assertCompileTimeReadonly;
  });

  test("默认配置由启动快照提供，之后复用同一份", async () => {
    // 提示词每次判定都要拼一遍；取同一份启动快照，不重读部署文件。
    expect(getAdDetectConfig()).toBe(getAdDetectConfig());
    expect(getAdDetectConfig()).toEqual(await loadAdDetectConfig());
  });
});
