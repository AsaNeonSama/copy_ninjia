/**
 * 性能基准出站硬闸与罐头 Telegram 应答单元测试（`scripts/perf/outboundGuard.ts`）：
 * - 验证 `installOutboundGuards` 拦截直接 `fetch` 与未放行的 grammY Bot API 出站请求；
 * - 验证 `installCannedTelegramOutbound` 装在 `deny` 外层后对已支持方法就地返回最小应答、记录 `cannedTelegramCalls` 与 `cannedTelegramCallTimes`、区分机器人/普通成员身份，并继续让未支持方法回落到 `deny` 硬闸。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { telegramApiState } from "../../packages/cache/perThread/telegramApi";
import { telegramApi } from "../../packages/infra/telegram/client";
import { bot } from "../../packages/infra/telegram/mainClient";
import {
  cannedTelegramCallTimes,
  cannedTelegramCalls,
  installCannedTelegramOutbound,
  installOutboundGuards,
} from "../../scripts/perf/outboundGuard";

const originalFetch: typeof fetch = globalThis.fetch;

afterAll((): void => {
  globalThis.fetch = originalFetch;
  telegramApiState.current = null;
  cannedTelegramCalls.clear();
  cannedTelegramCallTimes.clear();
});

describe("性能基准出站硬闸与罐头应答（outboundGuard.ts）", (): void => {
  test("installOutboundGuards 阻止 fetch 与 Bot API，随后 installCannedTelegramOutbound 接管支持方法并累计计数与时序", async (): Promise<void> => {
    // bot.api.config.use() 为单调叠加：必须在单个测试中先装 deny 硬闸，再在其外层安装罐头应答。
    installOutboundGuards();

    expect((): unknown => globalThis.fetch("https://api.example.invalid/test")).toThrow(
      "perf benchmark attempted a network call"
    );
    await expect(bot.api.sendMessage(-1001, "blocked-by-guard")).rejects.toThrow(
      "perf benchmark attempted Telegram API call 'sendMessage'"
    );

    cannedTelegramCalls.clear();
    cannedTelegramCallTimes.clear();
    installCannedTelegramOutbound();

    expect(bot.botInfo.id).toBe(1);
    const firstMsg = await bot.api.sendMessage(-1001, "canned-one");
    const secondMsg = await bot.api.sendMessage(-1001, "canned-two");
    expect(secondMsg.message_id).toBe(firstMsg.message_id + 1);
    expect(firstMsg.chat.id).toBe(-1001);

    const botMember = await bot.api.getChatMember(-1001, 1);
    const regularMember = await bot.api.getChatMember(-1001, 999);
    expect(botMember.status).toBe("administrator");
    expect(regularMember.status).toBe("member");

    const photoRes = await telegramApi.sendPhoto(-1001, {
      fileName: "sample.png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(photoRes.message_id).toBe(secondMsg.message_id + 1);

    expect(cannedTelegramCalls.get("sendMessage")).toBe(2);
    expect(cannedTelegramCalls.get("getChatMember")).toBe(2);
    expect(cannedTelegramCalls.get("sendPhoto")).toBe(1);
    expect(typeof cannedTelegramCallTimes.get("sendMessage")).toBe("number");
    expect(typeof cannedTelegramCallTimes.get("sendPhoto")).toBe("number");

    // 未在罐头表登记的方法继续穿过 answer 落到内层 deny 硬闸，绝不发起真实请求。
    await expect(bot.api.getMe()).rejects.toThrow(
      "perf benchmark attempted Telegram API call 'getMe'"
    );
    expect((): unknown => globalThis.fetch("https://api.example.invalid/still-blocked")).toThrow(
      "perf benchmark attempted a network call"
    );
  });
});
