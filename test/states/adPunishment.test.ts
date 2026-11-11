/**
 * 广告处罚动作表（纯规则）：处罚设置 × 发送者是否为频道身份。
 */

import { describe, expect, test } from "bun:test";
import {
  AD_PUNISHMENT_BAN_CHAT,
  AD_PUNISHMENT_BLOCK_GLOBAL,
  AD_PUNISHMENT_DELETE_ONLY,
  AD_PUNISHMENT_KICK,
} from "../../packages/consts/antiRaid/adDetect";
import { resolveAdPunishmentAction } from "../../packages/states/adPunishment";

describe("处罚动作表 resolveAdPunishmentAction", () => {
  test("mute 对普通用户禁言，原样带上时长或永久", () => {
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: 60_000 }, false))
      .toEqual({ kind: "mute", durationMs: 60_000 });
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: null }, false))
      .toEqual({ kind: "mute", durationMs: null });
  });

  test("kick 对普通用户按封禁范围选只踢不封、本群封禁或全局封禁", () => {
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: null }, false))
      .toBe(AD_PUNISHMENT_KICK);
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "chat" }, false))
      .toBe(AD_PUNISHMENT_BAN_CHAT);
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "global" }, false))
      .toBe(AD_PUNISHMENT_BLOCK_GLOBAL);
  });

  test("频道身份只有全局封禁照常执行，其余设置只删消息", () => {
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "global" }, true))
      .toBe(AD_PUNISHMENT_BLOCK_GLOBAL);
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "chat" }, true))
      .toBe(AD_PUNISHMENT_DELETE_ONLY);
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: null }, true))
      .toBe(AD_PUNISHMENT_DELETE_ONLY);
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: null }, true))
      .toBe(AD_PUNISHMENT_DELETE_ONLY);
  });
});
