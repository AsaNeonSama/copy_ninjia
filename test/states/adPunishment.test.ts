/**
 * 广告处罚动作表（纯规则）：处罚等级 × 发送者是否为频道身份。
 */

import { describe, expect, test } from "bun:test";
import { resolveAdPunishmentAction } from "../../packages/states/adPunishment";

describe("处罚动作表 resolveAdPunishmentAction", () => {
  test("等级 1 对普通用户禁言，原样带上时长或永久", () => {
    expect(resolveAdPunishmentAction({ level: 1, muteDurationMs: 60_000 }, false))
      .toEqual({ kind: "mute", durationMs: 60_000 });
    expect(resolveAdPunishmentAction({ level: 1, muteDurationMs: null }, false))
      .toEqual({ kind: "mute", durationMs: null });
  });

  test("等级 2 对普通用户按封禁范围选只踢不封、本群封禁或全局封禁", () => {
    expect(resolveAdPunishmentAction({ level: 2, blockScope: null }, false)).toEqual({ kind: "kick" });
    expect(resolveAdPunishmentAction({ level: 2, blockScope: "chat" }, false)).toEqual({ kind: "banChat" });
    expect(resolveAdPunishmentAction({ level: 2, blockScope: "global" }, false)).toEqual({ kind: "blockGlobal" });
  });

  test("频道身份只有全局封禁照常执行，其余等级只删消息", () => {
    expect(resolveAdPunishmentAction({ level: 2, blockScope: "global" }, true)).toEqual({ kind: "blockGlobal" });
    expect(resolveAdPunishmentAction({ level: 2, blockScope: "chat" }, true)).toEqual({ kind: "deleteOnly" });
    expect(resolveAdPunishmentAction({ level: 2, blockScope: null }, true)).toEqual({ kind: "deleteOnly" });
    expect(resolveAdPunishmentAction({ level: 1, muteDurationMs: null }, true)).toEqual({ kind: "deleteOnly" });
  });
});
