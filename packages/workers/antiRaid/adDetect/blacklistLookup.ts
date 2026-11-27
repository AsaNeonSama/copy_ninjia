/**
 * 广告包黑名单查询桥（Anti-Raid Worker 侧）：经双工桥向主线程批量核对候选贴纸包或自定义表情包是否命中黑名单
 * （主线程先查 768 LRU 缓存，冷缺失再打到 Disk I/O SQLite）。
 */
import { requestMainThread } from "../../../libs/workerDuplex";
import type { AdPackBlacklistKind } from "../../../types/adPackBlacklist";
import type { AntiRaidWorkerRequest } from "../../../types/antiRaid/protocol";

/**
 * Worker 通过既有双工桥向主线程核对指定种类下首批命中的广告黑名单包名。
 *
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param packs 去重后的合法候选包名列表。
 * @returns 首个命中的包名 short name；均未命中时返回 `null`。
 */
export function requestMatchAdPackBlacklist(
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): Promise<string | null> {
  if (packs.length === 0) return Promise.resolve(null);
  return requestMainThread<AntiRaidWorkerRequest, string | null>({
    operation: "matchAdPackBlacklist",
    kind,
    packs,
  });
}
