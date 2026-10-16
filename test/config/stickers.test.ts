import { describe, expect, test } from "bun:test";
import { loadStickerConfig, parseStickerConfig } from "../../packages/config/stickers";
import { MAX_CONFIGURED_STICKER_PACKS } from "../../packages/consts/aiChat/stickers";
import type { StickerConfig } from "../../packages/types/config";

describe("sticker config", () => {
  test("严格解析合法白名单，并能加载部署文件", async () => {
    expect(parseStickerConfig({ packs: ["pack_one", "Pack2"] })).toEqual({
      packs: ["pack_one", "Pack2"],
    });
    expect((await loadStickerConfig()).packs.length).toBeGreaterThan(0);
  });

  test("解析结果在编译期保持只读", () => {
    const assertReadonly = (config: StickerConfig): void => {
      // @ts-expect-error 贴纸包白名单引用为只读。
      config.packs = [];
      // @ts-expect-error 贴纸包白名单数组为只读，不得增删或覆写元素。
      config.packs.push("extra_pack");
      // @ts-expect-error 贴纸包白名单元素为只读。
      config.packs[0] = "replacement";
    };
    expect(assertReadonly).toBeDefined();
  });

  test("short name 按首尾空白规范化后校验、查重并保存", () => {
    expect(parseStickerConfig({ packs: [" pack_one ", "Pack2\n"] })).toEqual({ packs: ["pack_one", "Pack2"] });
    expect(() => parseStickerConfig({ packs: ["same", " same "] })).toThrow("must be unique");
    expect(() => parseStickerConfig({ packs: ["   "] })).toThrow("a valid Telegram sticker pack short name");
  });

  test("拒绝重复、非法 short name 和额外字段", () => {
    expect(() => parseStickerConfig({ packs: ["same", "same"] })).toThrow("must be unique");
    expect(() => parseStickerConfig({ packs: ["https://t.me/addstickers/x"] })).toThrow("a valid Telegram sticker pack short name");
    expect(() => parseStickerConfig({ packs: [], extra: true })).toThrow("exactly");
  });

  test("最多允许五个贴纸包，第六个会让启动配置预检失败", () => {
    const maximum = Array.from({ length: MAX_CONFIGURED_STICKER_PACKS }, (_, index) => `pack_${index}`);
    expect(parseStickerConfig({ packs: maximum }).packs).toEqual(maximum);
    expect(() => parseStickerConfig({ packs: [...maximum, "pack_overflow"] })).toThrow(
      `at most ${MAX_CONFIGURED_STICKER_PACKS} entries`
    );
  });
});
