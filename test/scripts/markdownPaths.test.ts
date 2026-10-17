import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectMarkdownPathProblems,
  collectRepositoryPaths,
} from "../../scripts/conventions/markdownPaths";

const temporaryRoots: string[] = [];

afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 创建包含受跟踪文件与未进入受跟踪集合的本地文件的临时仓库。 */
async function projectFixture(): Promise<{
  readonly root: string;
  readonly repositoryPaths: ReadonlySet<string>;
}> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-markdown-paths-"));
  temporaryRoots.push(root);
  const trackedFiles: readonly string[] = [
    "packages/consts/diskIO/common.ts",
    "packages/consts/randomImage.ts",
    "scripts/conventions/markdownPaths.ts",
    "test/scripts/markdownPaths.test.ts",
    "docs/cn/07-operations.md",
    "config_example/static/bot.json",
    "prompt_example/system.md",
    "public/coverage_light.svg",
    "LICENSES/LICENSE",
  ];
  for (const file of trackedFiles) {
    await Bun.write(join(root, file), "export {};\n");
  }
  // 模拟工作树中存在但未进入受跟踪集合（如被 gitignore 忽略）的路径。
  await Bun.write(join(root, "packages/consts/untrackedLocal.ts"), "export {};\n");
  return {
    root,
    repositoryPaths: collectRepositoryPaths(trackedFiles),
  };
}

/** 写入一份 Markdown 文档并执行仓库路径核对。 */
async function problemsFor(
  root: string,
  repositoryPaths: ReadonlySet<string>,
  markdown: string
): Promise<readonly string[]> {
  const path: string = join(root, "docs", "en", "07-operations.md");
  await Bun.write(path, markdown);
  return collectMarkdownPathProblems(root, path, repositoryPaths);
}

describe("仓库路径集合构建", () => {
  test("收录文件自身与全部祖先目录", (): void => {
    const paths: ReadonlySet<string> = collectRepositoryPaths([
      "packages/consts/diskIO/common.ts",
    ]);
    expect([...paths].sort()).toEqual([
      "packages",
      "packages/consts",
      "packages/consts/diskIO",
      "packages/consts/diskIO/common.ts",
    ]);
  });
});

describe("文档仓库路径核对", () => {
  test("集合内的文件与目录（含尾部斜杠）放行", async (): Promise<void> => {
    const { root, repositoryPaths } = await projectFixture();
    expect(await problemsFor(root, repositoryPaths, [
      "- `packages/consts/diskIO/common.ts`",
      "- `packages/consts/randomImage.ts`",
      "- `packages/consts/diskIO/` 与 `packages/consts/diskIO`",
      "- `scripts/conventions/`、`test/scripts/`、`docs/cn/07-operations.md`",
      "- `config_example/static/bot.json`、`prompt_example/system.md`、`public/coverage_light.svg`、`LICENSES/LICENSE`",
      "- 部署数据前缀 `config/static/bot.json`、`memory/global/state.json`、`images/` 不属受核对前缀",
    ].join("\n"))).toEqual([]);
  });

  test("缺失文件与缺失目录命中并给出准确行号", async (): Promise<void> => {
    const { root, repositoryPaths } = await projectFixture();
    expect(await problemsFor(root, repositoryPaths, [
      "# Operations",
      "",
      "See `packages/consts/diskIO/shared.ts` for mode.",
      "See `packages/consts/images.ts` and `packages/missingDir/`.",
    ].join("\n"))).toEqual([
      "docs/en/07-operations.md:3 references a missing repository path: packages/consts/diskIO/shared.ts",
      "docs/en/07-operations.md:4 references a missing repository path: packages/consts/images.ts",
      "docs/en/07-operations.md:4 references a missing repository path: packages/missingDir/",
    ]);
  });

  test("只在工作树存在但不在受跟踪集合里的路径同样命中", async (): Promise<void> => {
    const { root, repositoryPaths } = await projectFixture();
    expect(await problemsFor(
      root,
      repositoryPaths,
      "Local file `packages/consts/untrackedLocal.ts` is not tracked.\n"
    )).toEqual([
      "docs/en/07-operations.md:1 references a missing repository path: packages/consts/untrackedLocal.ts",
    ]);
  });

  test("含 <domain>、*、{a,b}、xxx 等占位符或附带行列锚点的片段跳过", async (): Promise<void> => {
    const { root, repositoryPaths } = await projectFixture();
    expect(await problemsFor(root, repositoryPaths, [
      "- `packages/consts/<domain>.ts`",
      "- `packages/workers/<domain>/`",
      "- `packages/infra/telegram/actions/*`",
      "- `packages/workers/diskIO/verification{Codec,Recovery,Writes}.ts`",
      "- `test/commands/xxx.test.ts`",
      "- `packages/consts/randomImage.ts:10`",
      "- `docs/cn/04-invariants.md#persistence`",
    ].join("\n"))).toEqual([]);
  });

  test("fenced code 内的路径跳过，后续正文行号仍按原文计算", async (): Promise<void> => {
    const { root, repositoryPaths } = await projectFixture();
    expect(await problemsFor(root, repositoryPaths, [
      "```md",
      "Example missing `packages/consts/nonexistent.ts` inside fence",
      "```",
      "Outside fence `packages/consts/removed.ts`.",
    ].join("\n"))).toEqual([
      "docs/en/07-operations.md:4 references a missing repository path: packages/consts/removed.ts",
    ]);
  });
});
