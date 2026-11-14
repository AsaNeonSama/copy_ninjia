import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFiles, readCachedText } from "../../scripts/checkProjectConventions";
import { withoutMarkdownCodeFences } from "../../scripts/conventions/markdownSource";
import { pathExists, statOptionalPath } from "../../scripts/conventions/pathStat";
import { copyFixtureTree } from "../../scripts/fixtures/copyTree";
import {
  assertCondition,
  assertContains,
  assertEqual,
} from "../../scripts/installIsolation/assertions";
import {
  migrationPathContains,
  readMigrationFileRecords,
} from "../../scripts/migrations/files";
import type { MigrationFileRecord } from "../../scripts/migrations/files";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root: string = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach((): void => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("markdownSource 与 pathStat 约定辅助函数", () => {
  test("withoutMarkdownCodeFences 用等长空格替换 fenced code block 并保持行号对齐", () => {
    const raw: string = [
      "before [ok](./a.md)",
      "```ts",
      "const link = '[bad](./missing.md)';",
      "```",
      "~~~bash",
      "./ignored/path",
      "~~~",
      "after [end](./b.md)",
    ].join("\n");
    const stripped: string = withoutMarkdownCodeFences(raw);
    expect(stripped.length).toBe(raw.length);
    expect(stripped.split("\n").length).toBe(raw.split("\n").length);
    expect(stripped).toContain("before [ok](./a.md)");
    expect(stripped).toContain("after [end](./b.md)");
    expect(stripped).not.toContain("./missing.md");
    expect(stripped).not.toContain("./ignored/path");
    expect(stripped.indexOf("after [end](./b.md)")).toBe(raw.indexOf("after [end](./b.md)"));
  });

  test("statOptionalPath 与 pathExists 正确区分文件、目录、ENOENT 与 ENOTDIR", async () => {
    const root: string = makeTempRoot("copy-ninjia-path-stat-");
    const filePath: string = join(root, "alpha.txt");
    await Bun.write(filePath, "hello");

    const fileStats: Stats | null = await statOptionalPath(filePath);
    expect(fileStats?.isFile()).toBe(true);
    expect(await pathExists(root)).toBe(true);
    expect(await pathExists(filePath)).toBe(true);

    expect(await statOptionalPath(join(root, "missing.txt"))).toBeNull();
    expect(await pathExists(join(root, "missing.txt"))).toBe(false);

    // 常规文件之下继续拼接路径会触发 ENOTDIR，应归一化为 null/false。
    expect(await statOptionalPath(join(filePath, "child"))).toBeNull();
    expect(await pathExists(join(filePath, "child"))).toBe(false);
  });
});

describe("copyFixtureTree、installIsolation assertions 与 migrations/files", () => {
  test("copyFixtureTree 递归复制目录树并在 assertDestination 拒绝时中止写入", async () => {
    const root: string = makeTempRoot("copy-ninjia-copy-tree-");
    const srcDir: string = join(root, "src");
    const dstDir: string = join(root, "dst");
    mkdirSync(join(srcDir, "nested"), { recursive: true });
    await Bun.write(join(srcDir, "root.txt"), "root-body");
    await Bun.write(join(srcDir, "nested", "leaf.txt"), "leaf-body");

    const visited: string[] = [];
    await copyFixtureTree(srcDir, dstDir, (target: string): void => {
      visited.push(target);
    });
    expect(visited.length).toBe(4);
    expect(await Bun.file(join(dstDir, "root.txt")).text()).toBe("root-body");
    expect(await Bun.file(join(dstDir, "nested", "leaf.txt")).text()).toBe("leaf-body");

    await expect(
      copyFixtureTree(srcDir, join(root, "blocked"), (target: string): void => {
        if (target.endsWith("nested")) throw new Error("destination rejected");
      })
    ).rejects.toThrow("destination rejected");
  });

  test("assertCondition、assertEqual 与 assertContains 按精确语义通过或抛出错误", () => {
    assertCondition(true, "ok");
    expect(() => assertCondition(false, "condition failed")).toThrow("condition failed");

    assertEqual(NaN, NaN, "nan equality");
    expect(() => assertEqual(-0, +0, "signed zero differs")).toThrow("signed zero differs");
    expect(() => assertEqual("a", "b", "value mismatch")).toThrow("value mismatch");

    assertContains("hello world", "world", "contains");
    expect(() => assertContains("hello", "xyz", "missing substr")).toThrow("missing substr");
  });

  test("readMigrationFileRecords 与 migrationPathContains 核对普通文件、符号链接拒绝与父子路径判定", async () => {
    const root: string = makeTempRoot("copy-ninjia-mig-files-");
    mkdirSync(join(root, "sub"), { recursive: true });
    await Bun.write(join(root, "a.json"), '{"k":1}');
    await Bun.write(join(root, "sub", "b.txt"), "abc");
    symlinkSync(join(root, "a.json"), join(root, "link.json"));

    const records: readonly MigrationFileRecord[] = await readMigrationFileRecords(root, ["a.json", "sub/b.txt"]);
    expect(records.length).toBe(2);
    expect(records[0]!.path).toBe("a.json");
    expect(records[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(records[1]!.path).toBe("sub/b.txt");

    await expect(readMigrationFileRecords(root, ["link.json"])).rejects.toThrow(
      "must be a regular file without symbolic links"
    );
    await expect(readMigrationFileRecords(root, ["sub"])).rejects.toThrow(
      "must be a regular file without symbolic links"
    );
    await expect(readMigrationFileRecords(root, ["missing.txt"])).rejects.toThrow();

    expect(migrationPathContains("/srv/app", "/srv/app")).toBe(true);
    expect(migrationPathContains("/srv/app", "/srv/app/data/db.sqlite")).toBe(true);
    expect(migrationPathContains("/srv/app", "/srv")).toBe(false);
    expect(migrationPathContains("/srv/app", "/srv/app-other/x")).toBe(false);
  });

  test("checkProjectConventions 导出的 projectFiles 与 readCachedText 行为准确且命中内存缓存", async () => {
    const files: string[] = projectFiles();
    expect(files).toContain("package.json");
    expect(files).toContain("scripts/checkProjectConventions.ts");

    const root: string = makeTempRoot("copy-ninjia-conv-cache-");
    const target: string = join(root, "sample.txt");
    await Bun.write(target, "first-content");
    const cache: Map<string, string> = new Map<string, string>();
    expect(await readCachedText(cache, target)).toBe("first-content");
    expect(cache.get(target)).toBe("first-content");

    await Bun.write(target, "second-content");
    expect(await readCachedText(cache, target)).toBe("first-content");
  });
});
