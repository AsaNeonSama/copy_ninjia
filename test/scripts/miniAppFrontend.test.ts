/**
 * Mini App 前端目录引用边界（scripts/conventions/miniAppFrontend.ts）。
 * 真实仓库全部合规，这里在临时仓库里逐条造违规样本，确认它们被拦下、合规写法放行。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectMiniAppFrontendBoundaryProblems,
  MINI_APP_FRONTEND_ENTRY_IMPORTS,
} from "../../scripts/conventions/miniAppFrontend";

const temporaryRoots: string[] = [];

afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 合规基线：前端只引用本目录与 npm 包，服务端只经登记的 HTML import 引用前端入口。 */
const COMPLIANT_FILES: Readonly<Record<string, string>> = {
  "packages/mini-app-frontend/index.html":
    '<link rel="icon" href="./miniAppResoures/favicon.ico" />\n' +
    '<script src="https://telegram.org/js/telegram-web-app.js"></script>\n' +
    '<link rel="stylesheet" href="./styles.css" />\n<script type="module" src="./main.tsx"></script>\n',
  "packages/mini-app-frontend/styles.css": '.a { background: url("./miniAppResoures/bg.svg"); }\n.b { background: url(data:image/png;base64,AA); }\n',
  "packages/mini-app-frontend/main.tsx":
    'import { createRoot } from "react-dom/client";\nimport type { T } from "./types/miniApp";\nimport { App } from "./App";\n',
  "packages/mini-app-frontend/types/miniApp.ts": "export type T = number;\n",
  "packages/mini-app-server/routes.ts": 'import indexHtml from "../mini-app-frontend/index.html";\n',
  "packages/mini-app-server/server.ts": 'import { MINI_APP_DEFAULT_HOST } from "../consts/miniApp";\n',
  "test/miniApp/example.test.ts": 'import { App } from "../../packages/mini-app-frontend/App";\n',
};

/**
 * 在临时仓库里写入合规基线与覆盖文件，返回仓库根与受跟踪文件列表。
 * @param overrides 追加或覆盖的文件内容
 * @returns 临时仓库根与受跟踪文件相对路径
 */
async function projectFixture(overrides: Readonly<Record<string, string>> = {}): Promise<{
  readonly root: string;
  readonly tracked: readonly string[];
}> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-mini-app-frontend-"));
  temporaryRoots.push(root);
  const files: Readonly<Record<string, string>> = { ...COMPLIANT_FILES, ...overrides };
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return { root, tracked: Object.keys(files) };
}

describe("Mini App 前端目录引用边界", () => {
  test("合规基线不报问题：本目录引用、npm 包、外部 URL、data URI、测试引用与登记的入口 import 均放行", async () => {
    const { root, tracked } = await projectFixture();
    expect(await collectMiniAppFrontendBoundaryProblems(root, tracked)).toEqual([]);
  });

  test("前端 TS/TSX 引用目录外文件一律拦下，纯类型引用与类型位置 import() 同样计入", async () => {
    const { root, tracked } = await projectFixture({
      "packages/mini-app-frontend/api.ts": 'import type { BotConfig } from "../types/config";\n',
      "packages/mini-app-frontend/App.tsx":
        'export const x = (): number => 1;\ntype P = import("../mini-app-server/picker").PrepareMiniAppPickerResult;\n',
      "packages/mini-app-frontend/store.ts": 'export { WHITELIST_PERMISSION_KEYS } from "../consts/whitelist";\n',
    });
    const problems: readonly string[] = await collectMiniAppFrontendBoundaryProblems(root, tracked);
    expect(problems).toEqual([
      expect.stringContaining("packages/mini-app-frontend/api.ts:1 references packages/types/config"),
      expect.stringContaining("packages/mini-app-frontend/App.tsx:2 references packages/mini-app-server/picker"),
      expect.stringContaining("packages/mini-app-frontend/store.ts:1 references packages/consts/whitelist"),
    ]);
  });

  test("前端 HTML 与 CSS 的相对资源引用越出目录时拦下", async () => {
    const { root, tracked } = await projectFixture({
      "packages/mini-app-frontend/index.html": '<link rel="icon" href="../mini-app-server/miniAppResoures/favicon.ico" />\n',
      "packages/mini-app-frontend/styles.css": '@import "../shared.css";\n',
    });
    const problems: readonly string[] = await collectMiniAppFrontendBoundaryProblems(root, tracked);
    expect(problems).toEqual([
      expect.stringContaining("packages/mini-app-frontend/index.html:1 references packages/mini-app-server/miniAppResoures/favicon.ico"),
      expect.stringContaining("packages/mini-app-frontend/styles.css:1 references packages/shared.css"),
    ]);
  });

  test("登记之外的生产模块引用前端时拦下，登记的引用方改引其它前端文件同样拦下", async () => {
    const { root, tracked } = await projectFixture({
      "packages/mini-app-server/http/statusRoutes.ts": 'import type { MiniAppTranslations } from "../../mini-app-frontend/types/miniAppI18n";\n',
      "index.ts": 'import { App } from "./packages/mini-app-frontend/App";\n',
      "packages/mini-app-server/routes.ts":
        'import indexHtml from "../mini-app-frontend/index.html";\nimport { formatBytes } from "../mini-app-frontend/formatters";\n',
    });
    const problems: readonly string[] = await collectMiniAppFrontendBoundaryProblems(root, tracked);
    expect(problems).toHaveLength(3);
    expect(problems).toContainEqual(expect.stringContaining("index.ts:1 references packages/mini-app-frontend/App"));
    expect(problems).toContainEqual(expect.stringContaining("packages/mini-app-server/http/statusRoutes.ts:1 references packages/mini-app-frontend/types/miniAppI18n"));
    expect(problems).toContainEqual(expect.stringContaining("packages/mini-app-server/routes.ts:2 references packages/mini-app-frontend/formatters"));
  });

  test("登记的入口 import 不再存在时报废弃登记", async () => {
    const { root, tracked } = await projectFixture({
      "packages/mini-app-server/routes.ts": "export {};\n",
    });
    const problems: readonly string[] = await collectMiniAppFrontendBoundaryProblems(root, tracked);
    expect(problems).toHaveLength(MINI_APP_FRONTEND_ENTRY_IMPORTS.size);
    for (const importer of MINI_APP_FRONTEND_ENTRY_IMPORTS.keys()) {
      expect(problems).toContainEqual(expect.stringContaining(`MINI_APP_FRONTEND_ENTRY_IMPORTS registers ${importer}`));
    }
  });
});
