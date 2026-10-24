import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deletedWedChats, dirtyWedChats, pendingWedMembers, resetWedFileWrites, wedFileFlushTimer, wedMemberDeletePersistedNotifier } from "../../../packages/cache/workers/diskIO/wed";
import { diskIOOperationTail } from "../../../packages/cache/workers/diskIO/recovery";
import { FLUSH_INTERVAL_MS } from "../../../packages/consts/diskIO/appendOnly";
import { WED_MEMORY_DIR } from "../../../packages/consts/paths";
import { WED_MEMBER_LIMIT } from "../../../packages/consts/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { deleteWedMemberFile, flushWedMemberFiles, handleWedMembersDeleteMessage, handleWedMembersMessage, inspectWedMemberFiles, maintainWedMemberFiles, writeWedMemberFile } from "../../../packages/workers/diskIO/wedMemberFiles";
import { handleDiskIOStartupLoad } from "../../../packages/workers/diskIO/startup";
import { handleDiskIOWorkerMessage } from "../../../packages/workers/diskIOWorker";
import { stopDiskIOMaintenanceCron } from "../../../packages/workers/diskIO/maintenanceCron";

const path: string = join(WED_MEMORY_DIR, "-1001.json");

test("旧删除失败后新快照取消删除，后续 flush 不擦除新文件", () => {
  let diskMembers: readonly number[] | undefined = [1, 10];
  let attempts: number = 0;
  const remove = (): void => { attempts++; throw new Error("mock unlink failure"); };
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    handleWedMembersDeleteMessage({ type: "deleteWedMembers", chatId: -1001, revision: 1 }, remove);
    handleWedMembersMessage({ type: "wedMembers", chatId: -1001, revision: 2, entries: [2, 20] });
    const write = (_chatId: number, entries: readonly number[]): void => { diskMembers = entries; };
    expect(flushWedMemberFiles(write, remove)).toBe(true);
    expect(flushWedMemberFiles(write, (): void => { diskMembers = undefined; })).toBe(true);
    expect(diskMembers).toEqual([2, 20]);
    expect(attempts).toBe(1);
    expect(deletedWedChats.size).toBe(0);
  } finally { diagnostic.mockRestore(); }
});

test("仅在 durable 删除成功后发送同编号回执，新删除丢弃旧快照", () => {
  const original = wedMemberDeletePersistedNotifier.current;
  const notify = mock();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  wedMemberDeletePersistedNotifier.current = notify;
  try {
    pendingWedMembers.set(-1001, [2, 20]);
    dirtyWedChats.add(-1001);
    handleWedMembersDeleteMessage({ type: "deleteWedMembers", chatId: -1001, revision: 9 }, (): never => { throw new Error("mock unlink failure"); });
    expect(notify).not.toHaveBeenCalled();
    expect(pendingWedMembers.size).toBe(0);
    expect(dirtyWedChats.size).toBe(0);
    const write = mock();
    expect(flushWedMemberFiles(write, (): void => {})).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ type: "wedMembersDeletedPersisted", chatId: -1001, revision: 9 });
  } finally { wedMemberDeletePersistedNotifier.current = original; diagnostic.mockRestore(); }
});

beforeEach(() => {
  resetWedFileWrites();
  rmSync(WED_MEMORY_DIR, { recursive: true, force: true });
});

afterEach(() => {
  stopDiskIOMaintenanceCron();
  resetWedFileWrites();
  rmSync(WED_MEMORY_DIR, { recursive: true, force: true });
  jest.useRealTimers();
});

test("启动 load 通过全部门禁后回传已建立的成员滑窗", async () => {
  writeWedMemberFile(-1001, [5974478892, 1000]);
  const reply = mock();
  await handleDiskIOStartupLoad(null, reply);
  expect(reply.mock.calls[0]![0]).toEqual(expect.objectContaining({
    type: "loaded", error: undefined, wedMembers: new Map([[-1001, new Map([[5974478892, 1000]])]]),
  }));
});

test("成员目录被普通文件占用时拒绝加载", async () => {
  await Bun.write(WED_MEMORY_DIR, "[]");
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${WED_MEMORY_DIR}: $type must be an accessible directory`);
});

test("文件缺省恢复为空；首次写自动建目录和文件，重启按文件顺序加载 ID 与进入时间", async () => {
  expect((await inspectWedMemberFiles()).snapshots.size).toBe(0);
  await handleDiskIOWorkerMessage({ type: "wedMembers", chatId: -1001, revision: 1, entries: [5974478892, 1000, 2, 1000, 7, 1001] });
  expect(await Bun.file(path).json()).toEqual([
    { id: 5974478892, enteredAt: 1000 }, { id: 2, enteredAt: 1000 }, { id: 7, enteredAt: 1001 },
  ]);
  expect(pendingWedMembers.size).toBe(0);
  resetWedFileWrites();
  const members: Map<number, number> = (await inspectWedMemberFiles()).snapshots.get(-1001)!;
  expect([...members]).toEqual([[5974478892, 1000], [2, 1000], [7, 1001]]);
  handleWedMembersMessage({ type: "wedMembers", chatId: -1001, revision: 2, entries: [] });
  expect(await Bun.file(path).json()).toEqual([]);
  expect(await Bun.file(`${path}.tmp`).exists()).toBeFalse();
});

test.each([
  ["{", "$"], ["{}", "$"], ["[null]", "$[0]"], ["[true]", "$[0]"], ["[1]", "$[0]"], ["[[1,0]]", "$[0]"],
  ["[{\"id\":1}]", "$[0]"], ["[{\"enteredAt\":0}]", "$[0]"], ["[{\"id\":1,\"enteredAt\":0,\"extra\":0}]", "$[0]"],
  ["[{\"id\":\"5974478892\",\"enteredAt\":0}]", "$[0].id"], ["[{\"id\":0,\"enteredAt\":0}]", "$[0].id"],
  ["[{\"id\":-1,\"enteredAt\":0}]", "$[0].id"], ["[{\"id\":1.5,\"enteredAt\":0}]", "$[0].id"],
  ["[{\"id\":9007199254740992,\"enteredAt\":0}]", "$[0].id"],
  ["[{\"id\":1,\"enteredAt\":0},{\"id\":1,\"enteredAt\":0}]", "$[1].id"],
  ["[{\"id\":1,\"enteredAt\":null}]", "$[0].enteredAt"], ["[{\"id\":1,\"enteredAt\":\"0\"}]", "$[0].enteredAt"],
  ["[{\"id\":1,\"enteredAt\":-1}]", "$[0].enteredAt"], ["[{\"id\":1,\"enteredAt\":1.5}]", "$[0].enteredAt"],
  ["[{\"id\":1,\"enteredAt\":9007199254740992}]", "$[0].enteredAt"],
  ["[{\"id\":1,\"enteredAt\":2},{\"id\":2,\"enteredAt\":1}]", "$[1].enteredAt"],
])("非法状态 %s 拒绝加载并保留原字节", async (content, field) => {
  await Bun.write(path, content);
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${path}: ${field} must be`);
  expect(await Bun.file(path).text()).toBe(content);
});

test.each(["1.json", "-01001.json", "-1e3.json", "-9007199254740992.json", "abc.json"])("非规范群文件名 %s 拒绝加载", async (name) => {
  const invalid = join(WED_MEMORY_DIR, name);
  await Bun.write(invalid, "[]");
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${invalid}: $filename must be`);
});

test("每群容量超限和群数超限均拒绝启动，不截断文件", async () => {
  const entries = Array.from({ length: WED_MEMBER_LIMIT }, (_, index) => ({ id: index + 1, enteredAt: 0 }));
  await Bun.write(path, JSON.stringify(entries));
  expect((await inspectWedMemberFiles()).snapshots.get(-1001)!.size).toBe(WED_MEMBER_LIMIT);
  entries.push({ id: WED_MEMBER_LIMIT + 1, enteredAt: 0 });
  const bytes = JSON.stringify(entries);
  await Bun.write(path, bytes);
  await expect(inspectWedMemberFiles()).rejects.toThrow(`at most ${WED_MEMBER_LIMIT}`);
  expect(await Bun.file(path).text()).toBe(bytes);
  await Bun.file(path).delete();
  for (let id = 1; id <= STATE_MANAGED_CHAT_LIMIT + 1; id++) {
    await Bun.write(join(WED_MEMORY_DIR, `${-id}.json`), "[]");
  }
  await expect(inspectWedMemberFiles()).rejects.toThrow(`${WED_MEMORY_DIR}: $ must be at most`);
});

test("临时文件只在全域成功后的 maintenance 清理", async () => {
  await Bun.write(`${path}.tmp`, "incomplete");
  const inspection = await inspectWedMemberFiles();
  expect(await Bun.file(`${path}.tmp`).exists()).toBeTrue();
  await maintainWedMemberFiles(inspection);
  expect(await Bun.file(`${path}.tmp`).exists()).toBeFalse();
});

test("启动 load 串联新门禁：失败不 adopt、不清理临时文件、不回显非法值", async () => {
  const content = "[\"sensitive-invalid-value\"]";
  await Bun.write(path, content);
  await Bun.write(`${path}.tmp`, "incomplete");
  pendingWedMembers.set(-99, [1, 0]);
  const reply = mock();
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleDiskIOStartupLoad(null, reply);
    expect(reply).toHaveBeenCalledTimes(1);
    const loaded = reply.mock.calls[0]![0];
    expect(loaded.type).toBe("loaded");
    expect(loaded.error).toContain(`${path}: $[0] must be`);
    expect(loaded.error).not.toContain("sensitive-invalid-value");
    expect(loaded.wedMembers.size).toBe(0);
    expect(pendingWedMembers.get(-99)).toEqual([1, 0]);
    expect(await Bun.file(`${path}.tmp`).exists()).toBeTrue();
    expect(await Bun.file(path).text()).toBe(content);
  } finally {
    diagnostic.mockRestore();
  }
});

test("原子替换失败保留旧文件和最新待写快照，重试成功后才清理 dirty", async () => {
  writeWedMemberFile(-1001, [1, 0]);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    pendingWedMembers.set(-1001, [2, 0]);
    dirtyWedChats.add(-1001);
    expect(flushWedMemberFiles((): never => { throw new Error("disk full"); })).toBeFalse();
    expect(await Bun.file(path).json()).toEqual([{ id: 1, enteredAt: 0 }]);
    expect(dirtyWedChats.has(-1001)).toBeTrue();
    handleWedMembersMessage({ type: "wedMembers", chatId: -1001, revision: 2, entries: [3, 0] });
    expect(pendingWedMembers.get(-1001)).toEqual([3, 0]);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await diskIOOperationTail.current;
    expect(await Bun.file(path).json()).toEqual([{ id: 3, enteredAt: 0 }]);
    expect(dirtyWedChats.size).toBe(0);
    expect(pendingWedMembers.size).toBe(0);
    expect(wedFileFlushTimer.timer).toBeNull();
  } finally {
    diagnostic.mockRestore();
  }
});

test("统一 flush 包含 wed 失败领域，其余领域继续排空", async () => {
  const workerGlobal = globalThis as typeof globalThis & { self: Worker };
  const original = workerGlobal.self;
  const reply = mock();
  workerGlobal.self = { postMessage: reply } as never;
  mkdirSync(path, { recursive: true });
  pendingWedMembers.set(-1001, [1, 0]);
  dirtyWedChats.add(-1001);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleDiskIOWorkerMessage({ type: "flush", scope: "all", flushId: 99 });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      type: "flushFailed", flushedId: 99, failedDomains: expect.arrayContaining(["wedMembers"]),
    }));
  } finally {
    workerGlobal.self = original;
    diagnostic.mockRestore();
  }
});

test("整群删除立即 unlink，并丢掉这个群仍未落盘的快照", async () => {
  writeWedMemberFile(-1001, [1, 0]);
  writeWedMemberFile(-2002, [2, 0]);
  pendingWedMembers.set(-1001, [1, 0, 3, 0]);
  dirtyWedChats.add(-1001);

  await handleDiskIOWorkerMessage({ type: "deleteWedMembers", chatId: -1001, revision: 1 });

  expect(await Bun.file(path).exists()).toBeFalse();
  // 待写快照一并丢掉，下一次 flush 不重新写出文件。
  expect(pendingWedMembers.has(-1001)).toBeFalse();
  expect(dirtyWedChats.has(-1001)).toBeFalse();
  expect(deletedWedChats.size).toBe(0);
  // 别的群一个字节都不动。
  expect(await Bun.file(join(WED_MEMORY_DIR, "-2002.json")).json()).toEqual([{ id: 2, enteredAt: 0 }]);
});

test("文件本来就不存在时删除照常成功，不留待删标记", async () => {
  mkdirSync(WED_MEMORY_DIR, { recursive: true });
  handleWedMembersDeleteMessage({ type: "deleteWedMembers", chatId: -1001, revision: 1 });
  expect(deletedWedChats.size).toBe(0);
  expect(flushWedMemberFiles()).toBeTrue();
});

test("删除失败保留待删标记并让本领域回报失败，重试成功后才放行", async () => {
  writeWedMemberFile(-1001, [1, 0]);
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    handleWedMembersDeleteMessage(
      { type: "deleteWedMembers", chatId: -1001, revision: 1 },
      (): never => { throw new Error("permission denied"); }
    );
    expect(deletedWedChats.has(-1001)).toBeTrue();
    expect(await Bun.file(path).exists()).toBeTrue();
    // 领域 flush 照实回报失败。
    expect(flushWedMemberFiles(writeWedMemberFile, (): never => { throw new Error("permission denied"); })).toBeFalse();
    expect(wedFileFlushTimer.timer).not.toBeNull();

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    await diskIOOperationTail.current;
    expect(await Bun.file(path).exists()).toBeFalse();
    expect(deletedWedChats.size).toBe(0);
    expect(flushWedMemberFiles()).toBeTrue();
  } finally {
    diagnostic.mockRestore();
  }
});

test("统一 flush 把仍未删净的群算进 wed 失败领域", async () => {
  const workerGlobal = globalThis as typeof globalThis & { self: Worker };
  const original = workerGlobal.self;
  const reply = mock();
  workerGlobal.self = { postMessage: reply } as never;
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  // 目录占住文件名：unlink 对目录报 EISDIR，删除因此失败并保留待删标记。
  mkdirSync(path, { recursive: true });
  try {
    handleWedMembersDeleteMessage({ type: "deleteWedMembers", chatId: -1001, revision: 1 });
    expect(deletedWedChats.has(-1001)).toBeTrue();
    await handleDiskIOWorkerMessage({ type: "flush", scope: "all", flushId: 77 });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      type: "flushFailed", flushedId: 77, failedDomains: expect.arrayContaining(["wedMembers"]),
    }));
  } finally {
    workerGlobal.self = original;
    diagnostic.mockRestore();
  }
});

test("删除边界本身幂等：删掉之后再删一次不抛错", () => {
  writeWedMemberFile(-1001, [1, 0]);
  deleteWedMemberFile(-1001);
  expect(() => deleteWedMemberFile(-1001)).not.toThrow();
});
