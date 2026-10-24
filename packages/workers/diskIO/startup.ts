/** Disk I/O Worker 启动恢复编排：全域只读 inspect、统一 adopt、成功后 maintenance。 */

import { stickerCatalogCache } from "../../cache/workers/diskIO/stickers";
import { resetWedFileWrites } from "../../cache/workers/diskIO/wed";
import { inspectWedMemberFiles, maintainWedMemberFiles } from "./wedMemberFiles";
import type { WedMemberInspection } from "./wedMemberFiles";
import { inspectLogFiles, adoptLogFiles, maintainLogFiles } from "./logFiles";
import { adoptAiCacheFile, inspectAiCacheFile, maintainAiCacheFile } from "./aiCacheFile";
import type { AiCacheInspection } from "./aiCacheFile";
import {
  adoptAiMemorySnapshots,
} from "./aiMemoryStorage";
import { adoptStickerCatalogSnapshots } from "./stickerCatalogFiles";
import {
  inspectLuckDay,
  inspectStickerCatalogs,
  maintainLuckDay,
  maintainStickerCatalogFiles,
} from "./snapshotFiles";
import { inspectJoinLogFiles, maintainJoinLogFiles } from "./joinLogRecovery";
import { adoptLuckDay } from "./luckFiles";
import { adoptLuckReceiptSecret, inspectLuckReceiptSecret } from "./luckSecretFile";
import {
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
} from "./verificationRecovery";
import {
  adoptStorageDatabase,
  inspectStorageDatabase,
  maintainTemporaryAdBypassActivities,
} from "./storageDatabase";
import { maintainAdSampleFiles } from "./adSampleFile";
import { runDiskIOMaintenanceTasks } from "./midnightMaintenance";
import {
  registerDiskIOMaintenanceCron,
  stopDiskIOMaintenanceCron,
} from "./maintenanceCron";
import { getDateKey } from "../../libs/time";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type { VerificationSnapshot } from "../../types/antiRaid/verification";
import type {
  IdentityStoragePersistedReply,
  LoadedReply,
  MidnightMaintenanceReply,
  VerificationPersistedReply,
} from "../../types/diskIO/replies";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LogFilesInspection } from "./logFiles";
import type {
  LuckDayRecoveryInspection,
  StickerCatalogRecoveryInspection,
} from "./snapshotFiles";
import type { LuckSecretRecoveryInspection } from "./luckSecretFile";
import type { JoinLogRecoveryInspection } from "./joinLogRecovery";
import type { VerificationRecoveryInspection } from "./verificationRecovery";
import type { StorageDatabaseInspection } from "../../types/identityStorage";
import { errorMessage } from "../../libs/errorMessage";

/** 启动加载及伴随维护流程向主线程发送回执的回调签名。 */
export type DiskIOStartupReplySink = (
  reply: LoadedReply | VerificationPersistedReply | IdentityStoragePersistedReply | MidnightMaintenanceReply
) => void;

/** 全域只读探测阶段产出的各领域快照汇总，供维护阶段统一消费。 */
interface StartupMaintenanceInspections {
  /** 日志目录与当日日志文件探测结果。 */
  readonly logs: LogFilesInspection;
  /** 贴纸目录快照探测结果。 */
  readonly stickerCatalogs: StickerCatalogRecoveryInspection;
  /** 入群日志目录探测结果。 */
  readonly joinLogs: JoinLogRecoveryInspection;
  /** 当日运势文件与运势目录探测结果。 */
  readonly luck: LuckDayRecoveryInspection;
  /** 待验证日文件恢复探测结果。 */
  readonly verifications: VerificationRecoveryInspection;
  /** `/wed` 群成员名册探测结果。 */
  readonly wedMembers: WedMemberInspection;
}

/**
 * 按固定顺序执行启动阶段各领域的维护清理任务。
 * @param inspections 全域只读探测阶段收集的各领域快照。
 * @param reply 向主线程发送持久化回执的回调。
 */
function runMaintenance(
  inspections: StartupMaintenanceInspections,
  reply: DiskIOStartupReplySink
): Promise<void> {
  return runDiskIOMaintenanceTasks("startup", [
    ["logs", (): Promise<void> => maintainLogFiles(inspections.logs)],
    ["ai cache", (): Promise<void> => maintainAiCacheFile()],
    ["wed members", (): Promise<void> => maintainWedMemberFiles(inspections.wedMembers)],
    ["sticker catalogs", (): Promise<void> => maintainStickerCatalogFiles(inspections.stickerCatalogs)],
    ["join logs", (): Promise<void> => maintainJoinLogFiles(inspections.joinLogs)],
    ["luck", (): Promise<void> => maintainLuckDay(inspections.luck.day, inspections.luck)],
    ["verifications", (): Promise<void> => maintainVerificationDay(inspections.verifications)],
    ["ad samples", (): Promise<void> => maintainAdSampleFiles()],
    ["temporary ad bypass", (): void => maintainTemporaryAdBypassActivities(reply)],
  ]);
}

/**
 * 执行 Disk I/O Worker 全域启动恢复：先只读 inspect 全部持久化领域，全部通过后统一 adopt，
 * 发送 loaded 回执后再执行维护任务并注册午夜维护 cron，参见 docs/cn/04-invariants.md。
 * @param stickerPacks 当前配置的贴纸包白名单；为 null 时不清理孤儿贴纸目录。
 * @param postReply 向主线程投递 `loaded` 与后续维护回执的出口。
 */
export async function handleDiskIOStartupLoad(
  stickerPacks: readonly string[] | null,
  postReply: DiskIOStartupReplySink
): Promise<void> {
  stopDiskIOMaintenanceCron();
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let aiMemories: Map<number, string> = new Map();
  let blocklistEntryCount: number = 0;
  let permissionEntryCount: number = 0;
  let pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let chatStates: Map<number, ChatState> = new Map();
  let chatQa: Map<number, ReadonlyMap<string, string>> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  let maintenanceInspections: StartupMaintenanceInspections | null = null;
  try {
    const today: string = getDateKey();
    const storage: StorageDatabaseInspection = inspectStorageDatabase();
    const logs: LogFilesInspection = await inspectLogFiles();
    const aiCache: AiCacheInspection = await inspectAiCacheFile();
    const stickerCatalogs: StickerCatalogRecoveryInspection =
      await inspectStickerCatalogs(stickerPacks);
    const joinLogs: JoinLogRecoveryInspection = await inspectJoinLogFiles(today);
    const luck: LuckDayRecoveryInspection = await inspectLuckDay(today);
    const luckSecret: LuckSecretRecoveryInspection = await inspectLuckReceiptSecret({
      day: today,
      confirmedResultCount: luck.cache?.entries.size ?? 0,
    });
    const verificationState: VerificationRecoveryInspection =
      await inspectVerificationDay(today);
    const wedMembers: WedMemberInspection = await inspectWedMemberFiles();

    const identityStorage: ReturnType<typeof adoptStorageDatabase> =
      adoptStorageDatabase(storage);
    adoptLogFiles(logs);
    adoptAiCacheFile(aiCache);
    resetWedFileWrites();
    aiMemories = adoptAiMemorySnapshots(storage.aiMemories);
    adoptStickerCatalogSnapshots(stickerCatalogs);
    adoptLuckDay(luck);
    verifications = adoptVerificationDay(verificationState);
    luckReceiptSecret = adoptLuckReceiptSecret(luckSecret);
    blocklistEntryCount = identityStorage.blocklistEntryCount;
    permissionEntryCount = identityStorage.permissionEntryCount;
    pendingBlockedRemovals = identityStorage.pendingBlockedRemovals;
    chatStates = identityStorage.chatStates;
    chatQa = identityStorage.chatQa;
    maintenanceInspections = {
      logs,
      stickerCatalogs,
      joinLogs,
      luck,
      verifications: verificationState,
      wedMembers,
    };
  } catch (error: unknown) {
    loadError = errorMessage(error);
    console.error("[diskIOWorker] startup recovery failed:", error);
  }

  postReply({
    type: "loaded",
    aiMemories,
    stickerCatalogs: stickerCatalogCache,
    luckDay: maintenanceInspections?.luck.cache ?? null,
    luckReceiptSecret,
    verifications,
    pendingBlockedRemovals,
    blocklistEntryCount,
    permissionEntryCount,
    chatStates,
    chatQa,
    wedMembers: maintenanceInspections?.wedMembers.snapshots ?? new Map(),
    error: loadError,
  });
  if (maintenanceInspections === null) return;
  await runMaintenance(maintenanceInspections, postReply);
  registerDiskIOMaintenanceCron(postReply);
}
