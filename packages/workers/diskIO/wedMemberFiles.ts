import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  deletedWedChats,
  dirtyWedChats,
  pendingWedMembers,
  wedFileFlushTimer,
  wedMemberDeletePersistedNotifier,
} from "../../cache/workers/diskIO/wed";
import { FLUSH_INTERVAL_MS } from "../../consts/diskIO/appendOnly";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { WED_MEMORY_DIR } from "../../consts/paths";
import { STATE_MANAGED_CHAT_LIMIT } from "../../consts/storage";
import { atomicWriteTextSync, durableUnlinkSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { assertFileReadableWritable, listOptionalDirectory } from "../../libs/fileAccess";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { parseWedMemberFile, parseWedMemberFileName, serializeWedMemberEntries } from "../../libs/wedMemberFile";
import type {
  WedMembersDeleteDiskMessage,
  WedMembersDiskMessage,
} from "../../types/diskIO/messages";
import { flushDirtyEntries } from "./dirtyFlush";

export interface WedMemberInspection {
  /** 群 ID → 成员 ID → 进入时间，插入顺序同文件顺序。 */
  readonly snapshots: ReadonlyMap<number, Map<number, number>>;
  /** 目录项全集，供启动维护清理 *.tmp 残留。 */
  readonly names: readonly string[];
}

/** 启动只读门禁：群总数在此验证，文件名与每份文件的项形态、唯一性、进入时间顺序与容量见 libs/wedMemberFile.ts。 */
export async function inspectWedMemberFiles(): Promise<WedMemberInspection> {
  const snapshots: Map<number, Map<number, number>> = new Map();
  const names: readonly string[] = listOptionalDirectory(WED_MEMORY_DIR);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path: string = join(WED_MEMORY_DIR, name);
    const chatId: number = parseWedMemberFileName(name, path);
    if (snapshots.size >= STATE_MANAGED_CHAT_LIMIT) {
      return invalidInput(WED_MEMORY_DIR, "$", `at most ${STATE_MANAGED_CHAT_LIMIT} group files`);
    }
    assertFileReadableWritable(path);
    snapshots.set(chatId, parseWedMemberFile(await readJsonInput(path), path));
  }
  return { snapshots, names };
}

/** 全域校验成功后创建目录并尽力清除未提交的临时文件，口径同其它领域的 *.tmp 清理。 */
export async function maintainWedMemberFiles(inspection: WedMemberInspection): Promise<void> {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  await removeOrphanedTempFiles(WED_MEMORY_DIR, inspection.names);
}

/** 唯一落盘边界；完整快照经现有 tmp、fsync、rename 实现原子替换，缺失文件自动创建。 */
export function writeWedMemberFile(chatId: number, entries: readonly number[]): void {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(WED_MEMORY_DIR, `${chatId}.json`), serializeWedMemberEntries(entries), PERSISTED_FILE_MODE);
}

/** 唯一删除边界；文件不存在按已删除处理，删掉后 fsync 目录项。 */
export function deleteWedMemberFile(chatId: number): void {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  durableUnlinkSync(join(WED_MEMORY_DIR, `${chatId}.json`));
}

/** 主线程已按 TTL/累计条数合并；到达 DiskIO 后直接提交，失败仅保留每群最新一份。 */
export function handleWedMembersMessage(message: WedMembersDiskMessage): void {
  deletedWedChats.delete(message.chatId);
  pendingWedMembers.set(message.chatId, message.entries);
  dirtyWedChats.add(message.chatId);
  if (wedFileFlushTimer.current === null) flushWedMemberFiles();
}

/**
 * 群 teardown 的整群删除：先丢掉这个群仍未落盘的快照，再立即尝试 unlink。
 *
 * 待写快照同步丢掉，不留给后续重试 timer。删除本身失败时保留待删标记，
 * 由普通重试 timer 继续尝试，领域 flush 期间照实回报失败。
 */
export function handleWedMembersDeleteMessage(
  message: WedMembersDeleteDiskMessage,
  remove: typeof deleteWedMemberFile = deleteWedMemberFile
): void {
  pendingWedMembers.delete(message.chatId);
  dirtyWedChats.delete(message.chatId);
  deletedWedChats.set(message.chatId, message.revision);
  flushWedMemberDeletions(remove);
  if (deletedWedChats.size > 0) scheduleWedMemberFlush();
}

/** 逐群尝试删除；单群失败只记一行并保留待删标记，不连坐其余群。 */
function flushWedMemberDeletions(remove: typeof deleteWedMemberFile): void {
  for (const [chatId, revision] of deletedWedChats) {
    try {
      remove(chatId);
      deletedWedChats.delete(chatId);
      wedMemberDeletePersistedNotifier.current({ type: "wedMembersDeletedPersisted", chatId, revision });
    } catch (error: unknown) {
      console.error(`[diskIOWorker] failed to delete wed members for chat ${chatId}:`, error);
    }
  }
}

/** 待写与待删共用同一个重试 timer；不阻止进程退出。 */
function scheduleWedMemberFlush(): void {
  if (wedFileFlushTimer.current !== null) return;
  wedFileFlushTimer.current = setTimeout(flushWedMemberFiles, FLUSH_INTERVAL_MS);
  wedFileFlushTimer.current.unref();
}

/**
 * 复用统一 dirty flush 与原子写入；强制 flush 同样报告本领域失败，重试 timer 不阻止退出。
 *
 * 新写入撤销旧删除，删除入口丢弃旧快照；同群只有最后一种操作持有重试责任。
 */
export function flushWedMemberFiles(
  write: typeof writeWedMemberFile = writeWedMemberFile,
  remove: typeof deleteWedMemberFile = deleteWedMemberFile
): boolean {
  if (wedFileFlushTimer.current !== null) clearTimeout(wedFileFlushTimer.current);
  wedFileFlushTimer.current = null;
  flushWedMemberDeletions(remove);
  flushDirtyEntries({
    dirty: dirtyWedChats,
    cache: pendingWedMembers,
    write,
    describeFailure: (chatId: number): string => `[diskIOWorker] failed to write wed members for chat ${chatId}:`,
  });
  for (const chatId of pendingWedMembers.keys()) {
    if (!dirtyWedChats.has(chatId)) pendingWedMembers.delete(chatId);
  }
  if (dirtyWedChats.size > 0 || deletedWedChats.size > 0) scheduleWedMemberFlush();
  return dirtyWedChats.size === 0 && deletedWedChats.size === 0;
}
