import { describe, expect, test } from "bun:test";
import { getAdSampleConfig, loadAdSampleConfig, parseAdSampleConfig } from "../../packages/config/adSamples";
import {
  AD_SAMPLE_MAX_CHARS,
  MAX_CONFIGURED_AD_BLACKLIST_PACKS,
  MAX_CONFIGURED_AD_SAMPLES,
} from "../../packages/consts/antiRaid/adDetect";
import type { AdSampleConfig } from "../../packages/types/config";

describe("ad samples config", () => {
  test("顶层包含 samples、sticker_black_list 与 emoji_black_list，空白规范化后保留", async () => {
    // 示例按行拼进提示词；带换行的示例被折叠成单行，包名去掉首尾空白。
    expect(parseAdSampleConfig({
      samples: [" 加  微信\n拉群 ", "USDT 承兑"],
      sticker_black_list: ["  SpamStickerPack_1  "],
      emoji_black_list: ["  SpamEmojiPack_1  "],
    })).toEqual({
      samples: ["加 微信 拉群", "USDT 承兑"],
      stickerBlackList: ["SpamStickerPack_1"],
      emojiBlackList: ["SpamEmojiPack_1"],
    });
    expect((await loadAdSampleConfig()).samples.length).toBeGreaterThan(0);
  });

  test("拒绝缺失或多余字段、非数组、非字符串、空白、非法包名与重复条目", () => {
    expect(() => parseAdSampleConfig(["旧数组结构"])).toThrow(
      "exactly { samples: string[], sticker_black_list: string[], emoji_black_list: string[] }"
    );
    expect(() => parseAdSampleConfig({ samples: [] })).toThrow(
      "exactly { samples: string[], sticker_black_list: string[], emoji_black_list: string[] }"
    );
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: [],
      emoji_black_list: [],
      extra: [],
    })).toThrow("exactly { samples: string[], sticker_black_list: string[], emoji_black_list: string[] }");
    expect(() => parseAdSampleConfig({
      samples: [42],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("a non-empty string");
    expect(() => parseAdSampleConfig({
      samples: ["   "],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("a non-empty string");
    // 折叠空白之后才判重：同一条广告多写两个空格按同一条处理。
    expect(() => parseAdSampleConfig({
      samples: ["加 微信", "加  微信"],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow("unique after whitespace normalization");

    // 贴纸与表情黑名单必须为合法 Telegram short name 且唯一。
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: ["bad pack name"],
      emoji_black_list: [],
    })).toThrow("a valid Telegram sticker pack short name");
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: ["Pack_1", " Pack_1 "],
      emoji_black_list: [],
    })).toThrow("unique");
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: [],
      emoji_black_list: ["invalid-hyphen"],
    })).toThrow("a valid Telegram sticker pack short name");
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: [],
      emoji_black_list: ["Emoji_1", "Emoji_1"],
    })).toThrow("unique");
  });

  test("samples、sticker_black_list 与 emoji_black_list 条数及单条长度都有上界", () => {
    const maximum: string[] = Array.from({ length: MAX_CONFIGURED_AD_SAMPLES }, (_, index) => `sample_${index}`);
    expect(parseAdSampleConfig({
      samples: maximum,
      sticker_black_list: [],
      emoji_black_list: [],
    }).samples).toHaveLength(MAX_CONFIGURED_AD_SAMPLES);
    expect(() => parseAdSampleConfig({
      samples: [...maximum, "overflow"],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_SAMPLES} entries`);
    expect(() => parseAdSampleConfig({
      samples: ["x".repeat(AD_SAMPLE_MAX_CHARS + 1)],
      sticker_black_list: [],
      emoji_black_list: [],
    })).toThrow(`no longer than ${AD_SAMPLE_MAX_CHARS} characters`);

    const maxPacks: string[] = Array.from(
      { length: MAX_CONFIGURED_AD_BLACKLIST_PACKS },
      (_, index) => `Pack_${index}`
    );
    expect(parseAdSampleConfig({
      samples: [],
      sticker_black_list: maxPacks,
      emoji_black_list: maxPacks,
    }).stickerBlackList).toHaveLength(MAX_CONFIGURED_AD_BLACKLIST_PACKS);
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: [...maxPacks, "Overflow_Pack"],
      emoji_black_list: [],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_BLACKLIST_PACKS} entries`);
    expect(() => parseAdSampleConfig({
      samples: [],
      sticker_black_list: [],
      emoji_black_list: [...maxPacks, "Overflow_Pack"],
    })).toThrow(`at most ${MAX_CONFIGURED_AD_BLACKLIST_PACKS} entries`);
  });

  test("解析结果只读，调用方改不动共享单例", () => {
    const probe: AdSampleConfig = parseAdSampleConfig({
      samples: ["加微信"],
      sticker_black_list: ["BadSticker"],
      emoji_black_list: ["BadEmoji"],
    });
    expect(probe).toEqual({
      samples: ["加微信"],
      stickerBlackList: ["BadSticker"],
      emojiBlackList: ["BadEmoji"],
    });
    const assertCompileTimeReadonly = (): void => {
      // @ts-expect-error 顶层字段只读
      probe.samples = [];
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
    expect(getAdSampleConfig()).toBe(getAdSampleConfig());
    expect(getAdSampleConfig()).toEqual(await loadAdSampleConfig());
  });
});
