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
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

export interface WedMemberInspection {
  /** 群 ID → 成员 ID → 进入时间，插入顺序同文件顺序。 */
  readonly snapshots: ReadonlyMap<number, Map<number, number>>;
  /** 目录项全集，供启动维护清理 *.tmp 残留。 */
  readonly names: readonly string[];
}

/**
 * 启动只读校验：校验群文件总数及各文件名与内容（单文件解析见 libs/wedMemberFile.ts）。
 * @returns 包含各群成员快照映射与目录文件名列表的只读探测结果。
 */
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

/**
 * 全域校验成功后创建目录并清理残留临时文件。
 * @param inspection 启动只读扫描阶段产出的 wed 成员目录探测结果。
 */
export async function maintainWedMemberFiles(inspection: WedMemberInspection): Promise<void> {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  await removeOrphanedTempFiles(WED_MEMORY_DIR, inspection.names);
}

/**
 * 原子覆盖写入指定群的 wed 成员快照文件。
 * @param chatId 目标群 ID。
 * @param entries 交错排列的 `[userId, seenAt, ...]` 成员快照数组。
 */
export function writeWedMemberFile(chatId: number, entries: readonly number[]): void {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(join(WED_MEMORY_DIR, `${chatId}.json`), serializeWedMemberEntries(entries), PERSISTED_FILE_MODE);
}

/**
 * 删除指定群的 wed 成员文件并同步父目录。
 * @param chatId 目标群 ID。
 */
export function deleteWedMemberFile(chatId: number): void {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  durableUnlinkSync(join(WED_MEMORY_DIR, `${chatId}.json`));
}

/**
 * 接收群 wed 成员快照并标记 dirty，未挂起重试 timer 时立即尝试写入。
 * @param message 群 wed 成员快照落盘消息。
 */
export function handleWedMembersMessage(message: WedMembersDiskMessage): void {
  deletedWedChats.delete(message.chatId);
  pendingWedMembers.set(message.chatId, message.entries);
  dirtyWedChats.add(message.chatId);
  if (wedFileFlushTimer.timer === null) flushWedMemberFiles();
}

/**
 * 丢弃指定群未落盘的快照并执行文件删除，失败时保留待删标记并调度重试。
 * @param message 群 wed 成员文件删除请求消息。
 * @param remove 执行单群文件删除的函数；缺省为生产实现。
 */
export function handleWedMembersDeleteMessage(
  message: WedMembersDeleteDiskMessage,
  remove: typeof deleteWedMemberFile = deleteWedMemberFile
): void {
  pendingWedMembers.delete(message.chatId);
  dirtyWedChats.delete(message.chatId);
  deletedWedChats.set(message.chatId, message.revision);
  flushWedMemberDeletions(remove);
  if (deletedWedChats.size > 0) armDiskIOFlushTimer(wedFileFlushTimer, FLUSH_INTERVAL_MS, flushWedMemberFiles);
}

/**
 * 逐群执行待删文件清理并发出回执；单群失败记录错误并保留待删标记。
 * @param remove 执行单群文件删除的函数。
 */
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

/**
 * 执行 wed 成员待删与待写落盘，存在未完成项时重新注册重试 timer。
 * @param write 执行单群快照写入的函数；缺省为生产实现。
 * @param remove 执行单群文件删除的函数；缺省为生产实现。
 * @returns 待写与待删集合均已全部清空时返回 true，仍有残留失败项时返回 false。
 */
export function flushWedMemberFiles(
  write: typeof writeWedMemberFile = writeWedMemberFile,
  remove: typeof deleteWedMemberFile = deleteWedMemberFile
): boolean {
  cancelDiskIOFlushTimer(wedFileFlushTimer);
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
  if (dirtyWedChats.size > 0 || deletedWedChats.size > 0) {
    armDiskIOFlushTimer(wedFileFlushTimer, FLUSH_INTERVAL_MS, flushWedMemberFiles);
  }
  return dirtyWedChats.size === 0 && deletedWedChats.size === 0;
}
