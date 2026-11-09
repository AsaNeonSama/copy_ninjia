/**
 * 广告处罚动作表（纯规则）：处罚设置 × 发送者是否为频道身份。
 */

import { describe, expect, test } from "bun:test";
import { resolveAdPunishmentAction } from "../../packages/states/adPunishment";

describe("处罚动作表 resolveAdPunishmentAction", () => {
  test("mute 对普通用户禁言，原样带上时长或永久", () => {
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: 60_000 }, false))
      .toEqual({ kind: "mute", durationMs: 60_000 });
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: null }, false))
      .toEqual({ kind: "mute", durationMs: null });
  });

  test("kick 对普通用户按封禁范围选只踢不封、本群封禁或全局封禁", () => {
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: null }, false)).toEqual({ kind: "kick" });
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "chat" }, false)).toEqual({ kind: "banChat" });
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "global" }, false)).toEqual({ kind: "blockGlobal" });
  });

  test("频道身份只有全局封禁照常执行，其余设置只删消息", () => {
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "global" }, true)).toEqual({ kind: "blockGlobal" });
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: "chat" }, true)).toEqual({ kind: "deleteOnly" });
    expect(resolveAdPunishmentAction({ kind: "kick", blockScope: null }, true)).toEqual({ kind: "deleteOnly" });
    expect(resolveAdPunishmentAction({ kind: "mute", durationMs: null }, true)).toEqual({ kind: "deleteOnly" });
  });
});
