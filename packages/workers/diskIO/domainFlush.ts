/**
 * Disk I/O Worker 按领域与 scope 的统一 flush：各领域缓冲立即落盘，失败按领域回报。
 * 回执出口由调用方（diskIOWorker.ts）传入。所属线程：Disk I/O Worker；本模块不持有缓存。
 */

import { flushAdSampleBuffer } from "./adSampleFile";
import { collectStorageDatabaseFailures, flushStorageDatabase } from "./storageDatabase";
import { flushLogBuffer } from "./logFiles";
import { flushAiCacheBuffer } from "./aiCacheFile";
import { flushLuckAppends } from "./luckFiles";
import { flushJoinLogBuffer } from "./joinLogFiles";
import { purgeJoinLogDeletions } from "./joinLogRecovery";
import { flushVerificationChanges } from "./verificationWrites";
import { flushStickerCatalogs } from "./stickerCatalogFiles";
import { flushWedMemberFiles } from "./wedMemberFiles";
import { takeVerificationWriteRejection } from "../../cache/workers/diskIO/verification";
import type { DiskFlushScope } from "../../types/diskIO/messages";
import type { DiskIODomain, DiskIOReply } from "../../types/diskIO/replies";

/**
 * 立即落盘指定领域的待写缓冲，失败时将领域追加到 failedDomains。
 * 共享 SQLite 各领域共用同一事务提交，仅收集当前请求领域的失败标记。
 */
async function flushDomain(
  domain: DiskIODomain,
  failedDomains: DiskIODomain[],
  reply: (reply: DiskIOReply) => void
): Promise<void> {
  switch (domain) {
    case "log":
      if (!await flushLogBuffer()) failedDomains.push("log");
      return;
    case "stickerCatalog":
      if (!flushStickerCatalogs()) failedDomains.push("stickerCatalog");
      return;
    case "wedMembers":
      if (!flushWedMemberFiles()) failedDomains.push("wedMembers");
      return;
    case "luck":
      if (!await flushLuckAppends()) failedDomains.push("luck");
      return;
    case "verification": {
      const rejected: boolean = takeVerificationWriteRejection();
      if (!await flushVerificationChanges(reply) || rejected) failedDomains.push("verification");
      return;
    }
    case "whitelist":
    case "blocklist":
    case "temporaryAdBypass":
    case "blocklistRemovalOutbox":
    case "chatState":
    case "chatQa":
    case "aiMemory":
      flushStorageDatabase(reply);
      collectStorageDatabaseFailures(domain, failedDomains);
      return;
    case "joinLog":
      if (!await flushJoinLogBuffer()) failedDomains.push("joinLog");
      return;
    case "joinLogPurge":
      if (!purgeJoinLogDeletions()) failedDomains.push("joinLogPurge");
      return;
    default: {
      const unhandled: never = domain;
      void unhandled;
    }
  }
}

/**
 * 按 scope 刷出对应领域缓冲并返回失败领域列表（范围定义见 types/diskIO/messages.ts 的 DiskFlushScope）。
 * `all` 与 `business` 额外刷出 AI 用量与广告样本旁路缓冲。
 */
export async function flushScope(
  scope: DiskFlushScope,
  reply: (reply: DiskIOReply) => void
): Promise<readonly DiskIODomain[]> {
  const failedDomains: DiskIODomain[] = [];
  if (scope !== "all" && scope !== "business") {
    await flushDomain(scope, failedDomains, reply);
    return failedDomains;
  }
  if (scope === "all") await flushDomain("log", failedDomains, reply);
  await flushAiCacheBuffer();
  await flushAdSampleBuffer();
  await flushDomain("stickerCatalog", failedDomains, reply);
  await flushDomain("wedMembers", failedDomains, reply);
  await flushDomain("luck", failedDomains, reply);
  await flushDomain("verification", failedDomains, reply);
  flushStorageDatabase(reply);
  collectStorageDatabaseFailures(null, failedDomains);
  await flushDomain("joinLog", failedDomains, reply);
  await flushDomain("joinLogPurge", failedDomains, reply);
  return failedDomains;
}
