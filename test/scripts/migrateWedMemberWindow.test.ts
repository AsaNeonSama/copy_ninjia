import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { WED_MEMBER_LIMIT } from "../../packages/consts/wed";
import { parseWedMemberFile } from "../../packages/libs/wedMemberFile";
import type { WedMemberEntry } from "../../packages/types/wed";
import { STAGING_FILE_MODE, prepareWedMemberWindowMigration } from "../../scripts/migrateWedMemberWindow";
import type { WedMemberWindowMigrationResult } from "../../scripts/migrateWedMemberWindow";
import { WED_MEMBER_WINDOW_SOURCE_LIMIT } from "../../scripts/migrations/wedMemberWindow/members";
import { TEST_DATA_ROOT } from "../preloadEnv";

let root: string;
let source: string;
let wed: string;

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "wed-member-window-migration-"));
  source = join(root, "source");
  wed = join(source, "memory/wed");
  mkdirSync(wed, { recursive: true });
  await Bun.write(join(wed, "-1001.json"), "[42,43]");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 源目录全部文件的逐字节快照；迁移必须原样保留。 */
async function sourceBytes(): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
  const files: Map<string, Uint8Array<ArrayBuffer>> = new Map<string, Uint8Array<ArrayBuffer>>();
  for await (const name of new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true, dot: true })) {
    files.set(name, await Bun.file(join(source, name)).bytes());
  }
  return files;
}

test("生产启动拒绝 17.2.1 的成员 ID 数组，迁移产物按进入顺序写成同一进入时间的滑窗并通过启动校验", async () => {
  const ids: readonly number[] = Array.from({ length: WED_MEMBER_LIMIT + 3 }, (_: unknown, index: number): number => index + 1);
  await Bun.write(join(wed, "-1002.json"), JSON.stringify(ids));
  await Bun.write(join(wed, "-1001.json.tmp"), "incomplete");
  expect(() => parseWedMemberFile([42, 43], join(wed, "-1001.json")))
    .toThrow(`${join(wed, "-1001.json")}: $[0] must be an object with exactly id and enteredAt.`);
  const before: ReadonlyMap<string, Uint8Array<ArrayBuffer>> = await sourceBytes();
  const startedAt: number = Date.now();
  const result: WedMemberWindowMigrationResult = await prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") });
  expect(result.enteredAt).toBeGreaterThanOrEqual(startedAt);
  expect(result.enteredAt).toBeLessThanOrEqual(Date.now());
  expect(result).toMatchObject({ chatCount: 2, keptMembers: 2 + WED_MEMBER_LIMIT, truncatedMembers: 3 });
  expect(result.sourceFiles.map((file: { readonly path: string }): string => file.path)).toEqual(["memory/wed/-1001.json", "memory/wed/-1002.json"]);
  expect(result.outputFiles.map((file: { readonly path: string }): string => file.path)).toEqual(["memory/wed/-1001.json", "memory/wed/-1002.json"]);
  expect(result.outputFiles.every((file: { readonly mode: number }): boolean => file.mode === STAGING_FILE_MODE)).toBeTrue();
  const small: string = join(result.outputRoot, "memory/wed/-1001.json");
  expect(await Bun.file(small).json()).toEqual([{ id: 42, enteredAt: result.enteredAt }, { id: 43, enteredAt: result.enteredAt }]);
  const large: string = join(result.outputRoot, "memory/wed/-1002.json");
  const entries: readonly WedMemberEntry[] = await Bun.file(large).json() as WedMemberEntry[];
  expect(entries.map((entry: WedMemberEntry): number => entry.id)).toEqual(ids.slice(-WED_MEMBER_LIMIT));
  expect(entries.every((entry: WedMemberEntry): boolean => entry.enteredAt === result.enteredAt)).toBeTrue();
  expect([...parseWedMemberFile(entries, large).keys()]).toEqual(ids.slice(-WED_MEMBER_LIMIT));
  expect(await Bun.file(join(result.outputRoot, "memory/wed/-1001.json.tmp")).exists()).toBeFalse();
  expect(await Bun.file(join(result.outputRoot, "ready.json")).json()).toEqual(result);
  expect(await Bun.file(join(result.outputRoot, "incomplete.json")).exists()).toBeFalse();
  expect(await sourceBytes()).toEqual(before);
});

test("没有群文件的成员目录产出空清单", async () => {
  await Bun.file(join(wed, "-1001.json")).delete();
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .resolves.toMatchObject({ chatCount: 0, keptMembers: 0, truncatedMembers: 0, sourceFiles: [], outputFiles: [] });
});

test.each([
  ["[{\"id\":42,\"enteredAt\":1}]", "$[0] must be a unique positive safe integer user ID from the 17.2.1 format"],
  ["[42,42]", "$[1] must be a unique positive safe integer user ID from the 17.2.1 format"],
  ["[0]", "$[0] must be"], ["[\"42\"]", "$[0] must be"], ["[1.5]", "$[0] must be"], ["{}", "$ must be the 17.2.1 array"],
  ["[", "$ must be a readable valid JSON document"],
])("非法或已迁移的源文件 %s 不产生 ready，源副本保持不变", async (content: string, message: string) => {
  await Bun.write(join(wed, "-1001.json"), content);
  const before: ReadonlyMap<string, Uint8Array<ArrayBuffer>> = await sourceBytes();
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow(`${join(wed, "-1001.json")}: ${message}`);
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
  expect(await sourceBytes()).toEqual(before);
});

test("源文件 ID 数超过 17.2.1 上限时拒绝", async () => {
  await Bun.write(join(wed, "-1001.json"), JSON.stringify(Array.from(
    { length: WED_MEMBER_WINDOW_SOURCE_LIMIT + 1 }, (_: unknown, index: number): number => index + 1
  )));
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow(`at most ${WED_MEMBER_WINDOW_SOURCE_LIMIT} unique positive safe integer user IDs`);
  expect(await Bun.file(join(root, "output/ready.json")).exists()).toBeFalse();
});

test.each(["1.json", "-01001.json", "-1e3.json", "abc.json"])("非规范群文件名 %s 在建立产物目录前拒绝", async (name: string) => {
  await Bun.write(join(wed, name), "[]");
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow(`${join(wed, name)}: $filename must be`);
  expect(await Bun.file(join(root, "output/incomplete.json")).exists()).toBeFalse();
});

test("群文件数超过 STATE_MANAGED_CHAT_LIMIT 时拒绝", async () => {
  for (let id: number = 2; id <= STATE_MANAGED_CHAT_LIMIT + 1; id++) await Bun.write(join(wed, `${-id}.json`), "[]");
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "output") }))
    .rejects.toThrow(`${wed}: $ must be at most ${STATE_MANAGED_CHAT_LIMIT} group files`);
});

test("成员目录缺失、目录或文件为符号链接时拒绝", async () => {
  const linked: string = join(root, "linked.json");
  await Bun.write(linked, "[42]");
  symlinkSync(linked, join(wed, "-1002.json"));
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "file-link") }))
    .rejects.toThrow("a regular file without symbolic links");
  await rm(wed, { recursive: true });
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "missing") })).rejects.toThrow();
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), wed);
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "directory-link") }))
    .rejects.toThrow(`${wed}: $type must be a directory without symbolic links`);
});

test("已迁移的产物不能再次作为源", async () => {
  const first: WedMemberWindowMigrationResult = await prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "first") });
  await expect(prepareWedMemberWindowMigration({ sourceRoot: first.outputRoot, outputRoot: join(root, "second") }))
    .rejects.toThrow("$[0] must be a unique positive safe integer user ID from the 17.2.1 format");
  expect(await Bun.file(join(root, "second/ready.json")).exists()).toBeFalse();
});

test("不覆盖既有输出，中断后在新输出目录重跑", async () => {
  mkdirSync(join(root, "interrupted"));
  await Bun.write(join(root, "interrupted/incomplete.json"), "preserve");
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "interrupted") })).rejects.toThrow();
  expect(await Bun.file(join(root, "interrupted/incomplete.json")).text()).toBe("preserve");
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(root, "retry") }))
    .resolves.toMatchObject({ chatCount: 1, keptMembers: 2 });
});

test("输出目录不得位于源备份内部，源备份也不得位于输出目录内部", async () => {
  await expect(prepareWedMemberWindowMigration({ sourceRoot: source, outputRoot: join(source, "output") }))
    .rejects.toThrow("a new directory outside the source backup");
  await expect(prepareWedMemberWindowMigration({ sourceRoot: wed, outputRoot: source }))
    .rejects.toThrow("a new directory outside the source backup");
});
