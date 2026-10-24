/**
 * Markdown 锚点解析（scripts/conventions/markdownAnchors.ts）。
 * 文档链接的 `#片段` 核对依赖它，口径必须与 GitHub 渲染一致。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMarkdownLocalLinks,
  collectMarkdownAnchors,
  markdownAnchors,
  markdownHtmlAnchors,
  markdownHtmlHeadingAnchors,
} from "../../scripts/conventions/markdownAnchors";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Markdown 标题锚点", () => {
  test("英文标题转小写、空白转连字符、标点丢弃", () => {
    expect([...markdownAnchors("# Startup and Import Boundaries\n")])
      .toEqual(["startup-and-import-boundaries"]);
    expect([...markdownAnchors("### `/wed` Member Persistence and Interaction\n")])
      .toEqual(["wed-member-persistence-and-interaction"]);
  });

  test("中日文标题原样保留，emoji 按标点丢弃", () => {
    expect([...markdownAnchors("## 可选凭据与严格配置预检\n")])
      .toEqual(["可选凭据与严格配置预检"]);
    expect([...markdownAnchors("### 任意の資格情報と設定の厳密な事前検証\n")])
      .toEqual(["任意の資格情報と設定の厳密な事前検証"]);
    expect([...markdownAnchors("## 🚀 快速开始\n")]).toEqual(["-快速开始"]);
  });

  test("同名标题按出现顺序追加序号", () => {
    expect([...markdownAnchors("## Notes\n## Notes\n## Notes\n")])
      .toEqual(["notes", "notes-1", "notes-2"]);
  });

  test("行内装饰与链接只取可见文字", () => {
    expect([...markdownAnchors("## **加粗** 与 [链接](x.md)\n")]).toEqual(["加粗-与-链接"]);
  });

  test("代码块里的井号不是标题", () => {
    expect([...markdownAnchors("```sh\n# not a heading\n```\n## real\n")]).toEqual(["real"]);
  });
});

describe("HTML 锚点", () => {
  test("HTML 标题按可见文字生成锚点", () => {
    expect([...markdownHtmlHeadingAnchors('<h1>\n  <a href="x"><img alt="y"></a>\n  Copy Ninjia\n</h1>')])
      .toEqual(["copy-ninjia"]);
  });

  test("显式 id / name 直接作为锚点", () => {
    expect([...markdownHtmlAnchors('<a id="Top"></a><div name="Bottom"></div>')])
      .toEqual(["top", "bottom"]);
  });

  test("三类锚点合并成同一份集合", () => {
    const anchors: ReadonlySet<string> = collectMarkdownAnchors(
      '<h1>Copy Ninjia</h1>\n<a id="top"></a>\n\n## 快速开始\n'
    );
    expect(anchors.has("copy-ninjia")).toBeTrue();
    expect(anchors.has("top")).toBeTrue();
    expect(anchors.has("快速开始")).toBeTrue();
  });
});

describe("checkMarkdownLocalLinks", () => {
  test("核对行内链接、HTML href/src 与引用定义的本地目标与锚点，忽略围栏代码块", async () => {
    const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-md-links-"));
    tempRoots.push(root);
    const targetPath: string = join(root, "target.md");
    const assetPath: string = join(root, "diagram.svg");
    const dirTargetPath: string = join(root, "dir.md");
    const docPath: string = join(root, "doc.md");
    mkdirSync(dirTargetPath, { recursive: true });
    await Bun.write(targetPath, "# Existing Heading\n\n## 中文标题\n\n<a id=\"custom-id\"></a>\n");
    await Bun.write(assetPath, "<svg></svg>\n");
    await Bun.write(
      docPath,
      [
        "# Local Heading",
        "[valid](./target.md#existing-heading)",
        "[cjk](./target.md#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98)",
        '<a href="./target.md#custom-id">html ok</a>',
        "[self-ok](#local-heading)",
        "[asset](./diagram.svg#icon)",
        "[dir](./dir.md#ignored-when-unreadable)",
        "[ext](https://example.com/a#b)",
        "[abs](/absolute/path)",
        "[proto](//example.com/path)",
        "```md",
        "[fenced](./missing-in-fence.md#no-anchor)",
        "```",
        "[missing-file](./no-such.md)",
        "[bad-anchor](./target.md#missing-anchor)",
        "[bad-pct-file](./%E0%A4%A.md)",
        "[bad-pct-anchor](./target.md#%E0%A4%A)",
        '<a href="./target.md#missing-html-anchor">html bad</a>',
        "[self-bad](#missing-self-anchor)",
        "[ref-missing]: ./missing-ref.md \"title\"",
        "[ref-bad-anchor]: ./target.md#missing-ref-anchor",
      ].join("\n") + "\n"
    );

    const failures: string[] = [];
    await checkMarkdownLocalLinks(root, docPath, failures);

    expect(failures).toEqual([
      "doc.md:14 local link target does not exist: ./no-such.md",
      "doc.md:15 link fragment has no matching heading in target.md: #missing-anchor",
      "doc.md:16 local link target does not exist: ./%E0%A4%A.md",
      "doc.md:17 link fragment has no matching heading in target.md: #%E0%A4%A",
      "doc.md:19 link fragment has no matching heading in doc.md: #missing-self-anchor",
      "doc.md:18 link fragment has no matching heading in target.md: #missing-html-anchor",
      "doc.md:20 local link target does not exist: ./missing-ref.md",
      "doc.md:21 link fragment has no matching heading in target.md: #missing-ref-anchor",
    ]);
  });
});
