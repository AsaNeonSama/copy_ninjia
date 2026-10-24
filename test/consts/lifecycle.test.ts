import { describe, expect, test } from "bun:test";
import { ANTI_RAID_DRAIN_TIMEOUT_MS } from "../../packages/consts/antiRaid/protocol";
import { DISK_IO_FLUSH_TIMEOUT_MS, NORMAL_FLUSH_TIMEOUTS, TRANSLATE_REQUEST_TIMEOUT_MS } from "../../packages/consts/lifecycle";

describe("停机预算常量", () => {
  test("Anti-Raid 排空预算覆盖其内部等待的 Disk I/O flush", () => {
    expect(ANTI_RAID_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(DISK_IO_FLUSH_TIMEOUT_MS);
    expect(NORMAL_FLUSH_TIMEOUTS.antiRaidMs).toBe(ANTI_RAID_DRAIN_TIMEOUT_MS);
  });

  test("翻译排空预算不短于单次翻译 RPC", () => {
    expect(NORMAL_FLUSH_TIMEOUTS.translateMs).toBeGreaterThanOrEqual(TRANSLATE_REQUEST_TIMEOUT_MS);
  });
});
