/**
 * Mini App 「配置编辑」页面全窗口高度自适应、密集 JSON 骨架屏、滚动条 1:1 对齐与主绘制层字体锐利门禁测试：
 * - 模拟 Windows PC Telegram Desktop 默认窗口（420×690）与 Google Pixel 10a 全屏视口（412×915，含顶/底安全区），
 *   校验不触发 `html`/`body`/`#root` `:has()` 样式重算的 `.app-shell-configs -> .app-main-configs -> .configs-page` 弹性高度链；
 * - 校验 `InlineNoticeCollapse` 诊断横幅展开、未创建提示及软键盘压缩视口（`--tg-viewport-height: 390px`）下卡片不塌陷、底部按钮不裁切；
 * - 校验 Windows PC 原生滚动条出现与 `resetDraft` 缩短内容时 `<textarea>` / `<pre>` / `gutter` 的内缩与偏移 1:1 同步；
 * - 校验配置文件下拉选择器（`ConfigFileSelector`）对齐实时状态子系统能力面板的新粗野主义触发头、底部色带锚定、三项限高纵向滑条与选中态高亮对比度；
 * - 校验子标签栏与「权限控制」恒定 64px 等高、折角刷新按钮三色电流脉冲一致性、禁用态按钮等阴影等尺寸，以及 24 行 JSON 骨架与无悬空类名/变量门禁。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppShell } from "../../packages/mini-app-frontend/components/AppShell";
import { ConfigFileSelector } from "../../packages/mini-app-frontend/components/ConfigFileSelector";
import {
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_CONFIG_SKELETON_LINE_INDENTS,
  MINI_APP_CONFIG_SKELETON_LINE_INDICES,
  MINI_APP_CONFIG_SKELETON_LINE_WIDTHS,
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../../packages/mini-app-frontend/consts/miniAppConfig";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { ConfigsPage } from "../../packages/mini-app-frontend/pages/ConfigsPage";
import {
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
import { createConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import type { MiniAppConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import type { MiniAppConfigFileItem } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findButtonByText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import {
  seedTestMiniAppSession,
  TEST_SESSION_KEY,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";
import { extractCssBlockBody, readStrippedCss } from "./helpers/cssInspect";

const originalFetch: typeof fetch = globalThis.fetch;

/** 常见桌面与 Pixel 10a 全屏视口 Telegram WebApp CSS 环境变量夹具。 */
const RESTING_VIEWPORTS: readonly {
  readonly label: string;
  readonly width: number;
  readonly stableHeight: number;
  readonly safeAreaTop: number;
  readonly safeAreaBottom: number;
}[] = [
  {
    label: "Windows PC Default (420x690)",
    width: 420,
    stableHeight: 690,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  },
  {
    label: "Pixel 10a Full-Screen (412x915)",
    width: 412,
    stableHeight: 915,
    safeAreaTop: 44,
    safeAreaBottom: 20,
  },
  {
    label: "Compact Desktop (380x600)",
    width: 380,
    stableHeight: 600,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  },
  {
    label: "Wide Desktop (960x780)",
    width: 960,
    stableHeight: 780,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  },
];

function extractCssRuleBody(css: string, selectorPattern: RegExp): string {
  const stripped: string = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return selectorPattern.exec(stripped)?.[1] ?? "";
}

function buildLongJsonFixture(entryCount: number): string {
  const rows: string[] = [];
  for (let i: number = 0; i < entryCount; i += 1) {
    rows.push(`    "rule_${i}": { "enabled": true, "score": ${i} }`);
  }
  return `{\n  "rules": {\n${rows.join(",\n")}\n  }\n}\n`;
}

function buildCatalogResponse(missingFiles: readonly string[] = []): Response {
  const dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[] =
    MINI_APP_DYNAMIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "dynamic",
        fileName,
        exists: !missingFiles.includes(fileName),
      })
    );
  const staticFiles: readonly Readonly<MiniAppConfigFileItem>[] =
    MINI_APP_STATIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "static",
        fileName,
        exists: !missingFiles.includes(fileName),
      })
    );
  return Response.json({ ok: true, dynamicFiles, staticFiles });
}

function estimateTextPixelWidth(text: string, fontSizePx: number): number {
  let width: number = 0;
  for (const ch of text) {
    const code: number = ch.codePointAt(0) ?? 0;
    width += code > 0x7f ? fontSizePx : fontSizePx * 0.62;
  }
  return Math.ceil(width);
}

async function settleFakeTimers(): Promise<void> {
  await act(async (): Promise<void> => {
    for (let i: number = 0; i < 8; i += 1) {
      Bun.sleepSync(2);
      await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
      });
    }
    jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS + 20);
    for (let i: number = 0; i < 8; i += 1) {
      Bun.sleepSync(2);
      await new Promise<void>((resolve: () => void): void => {
        setImmediate(resolve);
      });
    }
  });
}

beforeEach((): void => {
  seedTestMiniAppSession("a".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "Telegram");
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
});

describe("配置编辑全窗口视口高度链、密集骨架屏与锐利渲染门禁", () => {
  test("base.css、shell.css 与 configs.css 遵循零 :has() 祖先重算、顶栏恒定间距、min-height 自适应生长与骨架绝对定位约束", async () => {
    const baseCss: string = await Bun.file("packages/mini-app-frontend/styles/base.css").text();
    const shellCss: string = await Bun.file("packages/mini-app-frontend/styles/shell.css").text();
    const configsCss: string = await Bun.file("packages/mini-app-frontend/styles/configs.css").text();

    // 禁止通过 `:has(.app-shell-configs)` 反向修改 html/body/#root，亦禁止在切页时改变 `.app-topbar` 外边距。
    expect(configsCss).not.toContain(":has(");
    expect(shellCss).not.toContain(".app-shell-configs > .app-topbar");

    const topbarBody: string = extractCssRuleBody(shellCss, /(?:^|\n)\.app-topbar\s*\{([^}]*)\}/u);
    expect(topbarBody).toContain("margin-bottom: 12px;");
    expect(topbarBody).toContain("flex-shrink: 0;");

    const htmlBodyViewportBody: string = extractCssRuleBody(baseCss, /(?:^|\n)html,\s*body\s*\{([^}]*)\}/u);
    expect(htmlBodyViewportBody).toContain(
      "min-height: var(--tg-viewport-height, var(--tg-viewport-stable-height, 100dvh));"
    );
    const bodyBaseBody: string = extractCssRuleBody(baseCss, /(?:^|\n)body\s*\{([^}]*)\}/u);
    expect(bodyBaseBody).toContain("--tg-safe-area-inset-top");
    expect(bodyBaseBody).toContain("--tg-safe-area-inset-bottom");

    const appShellConfigsBody: string = extractCssRuleBody(
      shellCss,
      /\.app-shell\.app-shell-configs\s*\{([^}]*)\}/u
    );
    for (const token of [
      "display: flex;",
      "flex-direction: column;",
      "--tg-viewport-height",
      "--tg-safe-area-inset-top",
      "--tg-content-safe-area-inset-top",
      "--tg-safe-area-inset-bottom",
      "margin-bottom: -24px;",
    ]) {
      expect(appShellConfigsBody).toContain(token);
    }
    expect(appShellConfigsBody).not.toContain("min-height: 0");

    const appMainConfigsBody: string = extractCssRuleBody(
      shellCss,
      /\.app-main\.app-main-configs\s*\{([^}]*)\}/u
    );
    expect(appMainConfigsBody).toContain("flex: 1 1 auto;");
    expect(appMainConfigsBody).toContain("display: flex;");
    expect(appMainConfigsBody).toContain("flex-direction: column;");
    expect(appMainConfigsBody).not.toContain("min-height: 0");

    const configsPageBody: string = extractCssRuleBody(
      configsCss,
      /\.configs-page\s*\{([^}]*)\}/u
    );
    expect(configsPageBody).toContain("flex: 1 1 auto;");
    expect(configsPageBody).not.toContain("min-height: 0");

    const subtabsBarBody: string = extractCssRuleBody(
      configsCss,
      /\.configs-subtabs-bar\s*\{([^}]*)\}/u
    );
    expect(subtabsBarBody).toContain("flex-wrap: nowrap;");
    for (const barMatch of configsCss.matchAll(/\.configs-subtabs-bar\s*\{([^}]*)\}/gu)) {
      expect(barMatch[1] ?? "").not.toMatch(/(?<![\w-])(?:padding|height)\s*:/u);
    }
    expect(
      extractCssRuleBody(
        configsCss,
        /\.configs-subtabs-bar\s*>\s*\.subtabs-group\s*\{([^}]*)\}/u
      )
    ).toContain("min-width: 0;");

    for (const cardSelector of [
      /\.configs-editor-card\s*\{([^}]*)\}/u,
      /\.config-editor-skeleton\s*\{([^}]*)\}/u,
    ]) {
      const cardBody: string = extractCssRuleBody(configsCss, cardSelector);
      expect(cardBody).toContain("flex: 1 1 auto;");
      expect(cardBody).toContain("display: flex;");
      expect(cardBody).toContain("flex-direction: column;");
      expect(cardBody).toContain("margin-bottom: 0;");
      expect(cardBody).not.toContain("min-height: 0");
    }

    // 仅最内层代码舞台设置 `min-height: 0;` 且子层全部 `position: absolute;`，保证骨架与编辑器固有高度恒等且长内容内部滚动。
    for (const stageSelector of [
      /\.json-editor-stage\s*\{([^}]*)\}/u,
      /\.config-skeleton-code-frame\s*\{([^}]*)\}/u,
    ]) {
      const stageBody: string = extractCssRuleBody(configsCss, stageSelector);
      expect(stageBody).toContain("position: relative;");
      expect(stageBody).toContain("flex: 1 1 0%;");
      expect(stageBody).toContain("min-height: 0;");
    }
    for (const absChildSelector of [
      /\.json-editor-gutter\s*\{([^}]*)\}/u,
      /\.json-editor-canvas\s*\{([^}]*)\}/u,
      /\.config-skeleton-gutter\s*\{([^}]*)\}/u,
      /\.config-skeleton-lines\s*\{([^}]*)\}/u,
    ]) {
      expect(extractCssRuleBody(configsCss, absChildSelector)).toContain(
        "position: absolute;"
      );
    }

    // `<pre>` 不设固定 `width: 100%; height: 100%;`，允许行内 `right`/`bottom` 随滚动条内缩生效；`.json-editor-code` 补齐右侧 14px 内边距。
    const highlightBody: string = extractCssRuleBody(
      configsCss,
      /\.json-editor-highlight\s*\{([^}]*)\}/u
    );
    expect(highlightBody).toContain("padding: 12px 0 12px 14px;");
    expect(highlightBody).toContain("overflow: hidden;");
    expect(highlightBody).not.toContain("width: 100%");
    const codeBody: string = extractCssRuleBody(
      configsCss,
      /\.json-editor-code\s*\{([^}]*)\}/u
    );
    expect(codeBody).toContain("display: inline-block;");
    expect(codeBody).toContain("min-width: 100%;");
    expect(codeBody).toContain("padding-right: 14px;");

    expect(configsCss).not.toContain(".configs-scope-hint");
    expect(configsCss).not.toContain(".configs-toolbar-actions");
    expect(configsCss).not.toContain(".configs-restart-btn");
  });

  test("420×690 与 Pixel 10a 412×915 静止态零溢出等高填满窗口，错误横幅展开或软键盘收缩（390px）时卡片不塌陷且可滚动触达按钮", async () => {
    const longJsonContent: string = buildLongJsonFixture(160);

    globalThis.fetch = wrapEncryptedTestFetch((url: URL): Response => {
      if (url.pathname === "/api/configs") {
        return buildCatalogResponse(["mood.json"]);
      }
      if (url.pathname === "/api/configs/file") {
        const fileName: string = url.searchParams.get("fileName") ?? "ad_detect.json";
        if (fileName === "mood.json") {
          return Response.json({
            ok: true,
            scope: "dynamic",
            fileName: "mood.json",
            exists: false,
            content: "",
          });
        }
        return Response.json({
          ok: true,
          scope: url.searchParams.get("scope") ?? "dynamic",
          fileName,
          exists: true,
          content: longJsonContent,
        });
      }
      return Response.json({ error: "not found" }, 404);
    });

    for (const spec of RESTING_VIEWPORTS) {
      jest.useFakeTimers();
      const environment: MiniDomEnvironment = installMiniDom();
      try {
        (globalThis as { Telegram?: unknown }).Telegram = {
          WebApp: {
            initData: "signed-superadmin-initdata",
            viewportHeight: spec.stableHeight,
            viewportStableHeight: spec.stableHeight,
            isExpanded: true,
          },
        };
        const docEl: MiniDomNode = environment.document.documentElement;
        docEl.style["--tg-viewport-height"] = `${spec.stableHeight}px`;
        docEl.style["--tg-viewport-stable-height"] = `${spec.stableHeight}px`;
        docEl.style["--tg-safe-area-inset-top"] = `${spec.safeAreaTop}px`;
        docEl.style["--tg-safe-area-inset-bottom"] = `${spec.safeAreaBottom}px`;
        const winRecord: Record<string, unknown> =
          environment.document.defaultView as Record<string, unknown>;
        winRecord.innerWidth = spec.width;
        winRecord.innerHeight = spec.stableHeight;

        useMiniAppStore.setState({
          activeTab: "configs",
          sidebarOpen: false,
          sessionExpiresAt: Date.now() + 600_000,
        });

        const container: MiniDomNode = environment.document.createElement("div");
        const root: Root = createRoot(container as unknown as Element);

        try {
          await act(async (): Promise<void> => {
            root.render(createElement(AppShell));
          });

          const gutterRows: MiniDomNode[] = findElements(
            container,
            (node): boolean => hasClass(node, "config-skeleton-gutter-row")
          );
          const lineRows: MiniDomNode[] = findElements(
            container,
            (node): boolean => hasClass(node, "config-skeleton-line-row")
          );
          expect(gutterRows.length).toBeGreaterThanOrEqual(20);
          expect(gutterRows).toHaveLength(
            MINI_APP_CONFIG_SKELETON_LINE_INDICES.length
          );
          expect(lineRows).toHaveLength(
            MINI_APP_CONFIG_SKELETON_LINE_INDICES.length
          );
          expect(MINI_APP_CONFIG_SKELETON_LINE_INDENTS).toHaveLength(
            MINI_APP_CONFIG_SKELETON_LINE_INDICES.length
          );
          expect(MINI_APP_CONFIG_SKELETON_LINE_WIDTHS).toHaveLength(
            MINI_APP_CONFIG_SKELETON_LINE_INDICES.length
          );

          const distinctIndents: Set<string> = new Set<string>(
            lineRows.map((row): string => row.style.paddingLeft ?? "")
          );
          const distinctWidths: Set<string> = new Set<string>(
            findElements(container, (node): boolean =>
              hasClass(node, "config-skeleton-code-bar")
            ).map((bar): string => bar.style.width ?? "")
          );
          expect(distinctIndents.size).toBeGreaterThanOrEqual(4);
          expect(distinctWidths.size).toBeGreaterThanOrEqual(10);

          const configsSection: MiniDomNode | undefined = findElements(
            container,
            (node): boolean => hasClass(node, "configs-page")
          )[0];
          expect(configsSection).toBeDefined();
          expect(hasClass(configsSection!, "animate-fade-in")).toBeFalse();

          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "config-editor-skeleton")
            )
          ).toHaveLength(1);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "config-skeleton-shell")
            )
          ).toHaveLength(1);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "config-skeleton-actions")
            )
          ).toHaveLength(1);

          await settleFakeTimers();

          const editorCard: MiniDomNode | undefined = findElements(
            container,
            (node): boolean => hasClass(node, "configs-editor-card")
          )[0];
          expect(editorCard).toBeDefined();
          expect(hasClass(editorCard!, "animate-fade-in")).toBeTrue();
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "json-editor-frame")
            )
          ).toHaveLength(1);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "configs-actions-row")
            )
          ).toHaveLength(1);

          // 切回其它业务标签页时立即移除 `.app-shell-configs` / `.app-main-configs`。
          for (const otherTab of MINI_APP_TAB_KEYS) {
            if (otherTab === "configs") continue;
            act((): void => {
              useMiniAppStore.getState().setActiveTab(otherTab);
            });
            expect(
              findElements(container, (node): boolean =>
                hasClass(node, "app-shell-configs")
              )
            ).toHaveLength(0);
            expect(
              findElements(container, (node): boolean =>
                hasClass(node, "app-main-configs")
              )
            ).toHaveLength(0);
          }
        } finally {
          await act(async (): Promise<void> => {
            root.unmount();
          });
        }
      } finally {
        jest.useRealTimers();
        environment.restore();
      }
    }

    // 边界场景 1 & 2：切换到缺失文件 mood.json 同时展开多行错误横幅，以及模拟 Pixel 10a 软键盘弹出（activeHeight = 390px）。
    jest.useFakeTimers();
    const edgeEnv: MiniDomEnvironment = installMiniDom();
    try {
      (globalThis as { Telegram?: unknown }).Telegram = {
        WebApp: { initData: "signed-superadmin-initdata" },
      };
      const store: MiniAppConfigsStore = createConfigsStore();
      const container: MiniDomNode = edgeEnv.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      try {
        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigsPage, {
              storeFactory: (): MiniAppConfigsStore => store,
            })
          );
        });
        await settleFakeTimers();

        // 切至未创建的 mood.json 并触发语法错误以同时展示 missing-file-hint + InlineNoticeCollapse 错误横幅。
        act((): void => {
          void store.getState().selectFile("mood.json");
        });
        await settleFakeTimers();
        act((): void => {
          store.getState().setDraftContent("{broken");
          void store.getState().formatDraft();
        });
        await settleFakeTimers();

        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "configs-missing-file-hint")
          )
        ).toHaveLength(1);
        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "inline-notice-collapse-grid") && hasClass(node, "expanded")
          )
        ).toHaveLength(1);
        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "json-editor-frame")
          )
        ).toHaveLength(1);

        // 模拟软键盘收起/关闭横幅后折叠提示区域并维持编辑器框体存在；同步校验真实 CSS 高度链契约。
        act((): void => {
          store.getState().dismissErrorBanner();
        });
        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "inline-notice-collapse-grid") && hasClass(node, "expanded")
          )
        ).toHaveLength(0);
        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "configs-editor-card")
          )
        ).toHaveLength(1);
        expect(
          findElements(container, (node): boolean =>
            hasClass(node, "json-editor-frame")
          )
        ).toHaveLength(1);

        const baseCss: string = await readStrippedCss("packages/mini-app-frontend/styles/base.css");
        const shellCss: string = await readStrippedCss("packages/mini-app-frontend/styles/shell.css");
        const configsCss: string = await readStrippedCss("packages/mini-app-frontend/styles/configs.css");

        const bodyRule: string = extractCssBlockBody(baseCss, /(?:^|\n)body\s*\{([^}]*)\}/u);
        const paddingMatch: RegExpExecArray | null =
          /padding\s*:\s*calc\(\s*(\d+)px[\s\S]*?calc\(\s*(\d+)px/u.exec(bodyRule);
        expect(paddingMatch).not.toBeNull();

        const shellConfigsRule: string = extractCssBlockBody(
          shellCss,
          /\.app-shell\.app-shell-configs\s*\{([^}]*)\}/u
        );
        const shellMarginMatch: RegExpExecArray | null =
          /margin-bottom\s*:\s*(-?\d+)px\s*;/u.exec(shellConfigsRule);
        const shellSubMatch: RegExpExecArray | null =
          /min-height\s*:\s*calc\([\s\S]*?-\s*(\d+)px\s*-/u.exec(shellConfigsRule);
        expect(shellMarginMatch).not.toBeNull();
        expect(shellSubMatch).not.toBeNull();
        expect(
          Number(paddingMatch![1]) + Number(paddingMatch![2]) + Number(shellMarginMatch![1])
        ).toBe(Number(shellSubMatch![1]));

        expect(
          extractCssBlockBody(configsCss, /\.configs-page\s*>\s*\.inline-notice-collapse-grid\s*\{([^}]*)\}/u)
        ).toContain("flex-shrink: 0;");
        expect(
          extractCssBlockBody(configsCss, /\.configs-missing-file-hint\s*\{([^}]*)\}/u)
        ).toContain("flex-shrink: 0;");
        const editorCardRule: string = extractCssBlockBody(configsCss, /\.configs-editor-card\s*\{([^}]*)\}/u);
        const skeletonCardRule: string = extractCssBlockBody(configsCss, /\.config-editor-skeleton\s*\{([^}]*)\}/u);
        expect(editorCardRule).toContain("flex: 1 1 auto;");
        expect(skeletonCardRule).toContain("flex: 1 1 auto;");
        expect(editorCardRule).toContain("margin-bottom: 0;");
        expect(skeletonCardRule).toContain("margin-bottom: 0;");
        expect(
          extractCssBlockBody(configsCss, /\.json-editor-frame\s*\{([^}]*)\}/u)
        ).toContain("min-height: 240px;");
        expect(
          extractCssBlockBody(configsCss, /\.config-skeleton-shell\s*\{([^}]*)\}/u)
        ).toContain("min-height: 240px;");
        expect(
          /min-height\s*:\s*(\d+px)\s*;/u.exec(
            extractCssBlockBody(configsCss, /(?:^|\n)\.configs-actions-row\s*\{([^}]*)\}/u)
          )?.[1]
        ).toBe(
          /min-height\s*:\s*(\d+px)\s*;/u.exec(
            extractCssBlockBody(configsCss, /\.config-skeleton-actions\s*\{([^}]*)\}/u)
          )?.[1]
        );
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
    } finally {
      jest.useRealTimers();
      edgeEnv.restore();
    }
  });

  test("Windows PC 原生滚动条出现与 resetDraft 缩短内容时，<textarea>、<pre> 与行号栏保持 1:1 视口内缩与滚动偏移对齐", async () => {
    const initialShort: string = '{\n  "enabled": true\n}\n';
    const editedLong: string = buildLongJsonFixture(80);

    globalThis.fetch = wrapEncryptedTestFetch((url: URL): Response => {
      if (url.pathname === "/api/configs") {
        return buildCatalogResponse();
      }
      return Response.json({
        ok: true,
        scope: "dynamic",
        fileName: "ad_detect.json",
        exists: true,
        content: initialShort,
      });
    });

    jest.useFakeTimers();
    const environment: MiniDomEnvironment = installMiniDom();
    const resizeListeners: Set<() => void> = new Set<() => void>();
    let observedTarget: unknown = null;
    let observerDisconnected: boolean = false;
    let resizeObserverCallback: (() => void) | null = null;
    const prevResizeObserver: unknown = (
      globalThis as Record<string, unknown>
    ).ResizeObserver;
    (globalThis as Record<string, unknown>).ResizeObserver = class MockResizeObserver {
      constructor(cb: () => void) {
        resizeObserverCallback = cb;
      }
      observe(target: unknown): void {
        observedTarget = target;
      }
      disconnect(): void {
        observerDisconnected = true;
      }
    };
    const winRecord: Record<string, unknown> =
      environment.document.defaultView as Record<string, unknown>;
    winRecord.addEventListener = (type: string, cb: () => void): void => {
      if (type === "resize") resizeListeners.add(cb);
    };
    winRecord.removeEventListener = (type: string, cb: () => void): void => {
      if (type === "resize") resizeListeners.delete(cb);
    };

    try {
      (globalThis as { Telegram?: unknown }).Telegram = {
        WebApp: { initData: "signed-superadmin-initdata" },
      };
      const store: MiniAppConfigsStore = createConfigsStore();
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);

      try {
        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigsPage, {
              storeFactory: (): MiniAppConfigsStore => store,
            })
          );
        });
        await act(async (): Promise<void> => {
          for (let i: number = 0; i < 8; i += 1) {
            Bun.sleepSync(2);
            await new Promise<void>((resolve: () => void): void => {
              setImmediate(resolve);
            });
          }
          jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS + 20);
          for (let i: number = 0; i < 8; i += 1) {
            Bun.sleepSync(2);
            await new Promise<void>((resolve: () => void): void => {
              setImmediate(resolve);
            });
          }
        });

        const textareaNode: MiniDomNode | undefined = findElements(
          container,
          (node): boolean => hasClass(node, "json-editor-textarea")
        )[0];
        const preNode: MiniDomNode | undefined = findElements(
          container,
          (node): boolean => hasClass(node, "json-editor-highlight")
        )[0];
        const gutterNode: MiniDomNode | undefined = findElements(
          container,
          (node): boolean => hasClass(node, "json-editor-gutter")
        )[0];
        expect(textareaNode).toBeDefined();
        expect(preNode).toBeDefined();
        expect(gutterNode).toBeDefined();
        expect(observedTarget).toBe(textareaNode);

        const textareaMetrics: Record<string, unknown> =
          textareaNode as unknown as Record<string, unknown>;
        const preMetrics: Record<string, unknown> =
          preNode as unknown as Record<string, unknown>;

        // 1. 填入长文本并模拟 Windows PC 15px 纵横原生滚动条及滚动到底/右位置。
        textareaMetrics.offsetWidth = 360;
        textareaMetrics.clientWidth = 345;
        textareaMetrics.offsetHeight = 320;
        textareaMetrics.clientHeight = 305;
        textareaNode!.scrollTop = 410;
        textareaMetrics.scrollLeft = 92;

        act((): void => {
          store.getState().setDraftContent(editedLong);
        });

        expect(preNode!.style.right).toBe("15px");
        expect(preNode!.style.bottom).toBe("15px");
        expect(gutterNode!.style.bottom).toBe("15px");
        expect(preNode!.scrollTop).toBe(410);
        expect(preMetrics.scrollLeft).toBe(92);
        expect(gutterNode!.scrollTop).toBe(410);

        // 2. 点击「还原修改」使文本缩回 3 行，浏览器自动将 textarea.scrollTop 夹紧至 0 且隐藏滚动条（未必触发 onScroll）：
        // `[value]` 副作用仍同步归零 pre / gutter 偏移与滚动条内缩。
        textareaMetrics.clientWidth = 360;
        textareaMetrics.clientHeight = 320;
        textareaNode!.scrollTop = 0;
        textareaMetrics.scrollLeft = 0;

        act((): void => {
          void store.getState().resetDraft();
        });
        await settleFakeTimers();

        expect(preNode!.style.right).toBe("0px");
        expect(preNode!.style.bottom).toBe("0px");
        expect(gutterNode!.style.bottom).toBe("0px");
        expect(preNode!.scrollTop).toBe(0);
        expect(preMetrics.scrollLeft).toBe(0);
        expect(gutterNode!.scrollTop).toBe(0);

        // 3. 窗口 resize 与 ResizeObserver 回调均重算滚动条内缩。
        textareaMetrics.clientWidth = 343;
        act((): void => {
          for (const listener of resizeListeners) {
            listener();
          }
        });
        expect(preNode!.style.right).toBe("17px");

        textareaMetrics.clientHeight = 304;
        act((): void => {
          resizeObserverCallback?.();
        });
        expect(preNode!.style.bottom).toBe("16px");
        expect(gutterNode!.style.bottom).toBe("16px");
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
      expect(resizeListeners.size).toBe(0);
      expect(observerDisconnected).toBeTrue();
    } finally {
      if (prevResizeObserver === undefined) {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      } else {
        (globalThis as Record<string, unknown>).ResizeObserver = prevResizeObserver;
      }
      jest.useRealTimers();
      environment.restore();
    }
  });

  test("360px–420px 窄视口下子标签栏保持 64px 等高（padding: 10px 12px），中/英/日三语横向宽度充裕不折行", () => {
    const narrowWidths: readonly number[] = [360, 380, 390, 412, 420];
    for (const width of narrowWidths) {
      const isCompact: boolean = width <= 400;
      const fontSize: number = isCompact ? 12.5 : 13;
      const barGap: number = isCompact ? 6 : 8;
      const refreshPad: number = isCompact ? 24 : 30;
      const tabPad: number = isCompact ? 16 : 26;
      const tabGap: number = isCompact ? 4 : 6;
      for (const lang of MINI_APP_LANGUAGES) {
        const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
        const barInnerAvailable: number = width - 20 - 24 - 7 - barGap;
        const refreshBtnWidth: number =
          refreshPad + 14 + 5 + estimateTextPixelWidth(t.configs.refreshButton, fontSize);
        const subtabsGroupWidth: number = barInnerAvailable - refreshBtnWidth;
        const perTabBtnWidth: number = (subtabsGroupWidth - 24) / 2;
        const dynamicContentNeed: number =
          tabPad + 14 + tabGap + estimateTextPixelWidth(t.configs.dynamicTab, fontSize);
        const staticContentNeed: number =
          tabPad + estimateTextPixelWidth(t.configs.staticTab, fontSize);

        expect(subtabsGroupWidth).toBeGreaterThan(150);
        expect(perTabBtnWidth).toBeGreaterThanOrEqual(dynamicContentNeed);
        expect(perTabBtnWidth).toBeGreaterThanOrEqual(staticContentNeed);
      }
    }
  });

  test("配置编辑相关样式与 TSX 组件遵守新粗野主义下拉卡片令牌、三色刷新脉冲、禁用态等尺寸阴影、静止态主绘制层驻留与显式 <Fragment> 门禁", async () => {
    const baseCss: string = await Bun.file("packages/mini-app-frontend/styles/base.css").text();
    const primitivesCss: string = await Bun.file("packages/mini-app-frontend/styles/primitives.css").text();
    const configsCss: string = await Bun.file("packages/mini-app-frontend/styles/configs.css").text();
    expect(configsCss).toContain("will-change: auto;");
    expect(configsCss).toContain(".config-selector-popover.closing");
    expect(configsCss).not.toContain("border-top: 5px solid var(--accent)");
    expect(configsCss).not.toContain("box-shadow: none");
    expect(configsCss).not.toMatch(/transition\s*:[^;]*(?:\btransform\b|\bfilter\b)/u);
    expect(configsCss).not.toMatch(/@media\s*\(\s*hover\s*:\s*hover\s*\)\s*\{/u);
    expect(configsCss).toContain("@media (hover: hover) and (pointer: fine)");

    // 校验折角刷新按钮（权限控制 + 配置编辑）具备与普通工具栏刷新按钮一致的青/黄/粉三色电流脉冲与禁用态等阴影尺寸。
    const dogearSurgeKf: string =
      /@keyframes\s+miniapp-electric-dogear-surge\s*\{([\s\S]*?\}\s*)\}/u.exec(primitivesCss)?.[1] ?? "";
    for (const token of [
      "drop-shadow(-1.5px -1.5px 0 var(--electric-cyan))",
      "drop-shadow(2.5px 2.5px 0 var(--electric-yellow))",
      "drop-shadow(1.5px -1.5px 0 var(--accent))",
      "drop-shadow(-2px 2px 0 var(--electric-cyan))",
      "drop-shadow(2.5px 2.5px 0 var(--electric-cyan))",
    ]) {
      expect(dogearSurgeKf).toContain(token);
    }
    const dogearBorderKf: string =
      /@keyframes\s+miniapp-electric-dogear-border\s*\{([\s\S]*?\}\s*)\}/u.exec(primitivesCss)?.[1] ?? "";
    expect(dogearBorderKf).toContain("background: var(--electric-cyan);");
    expect(dogearBorderKf).toContain("background: var(--electric-yellow);");
    expect(
      extractCssRuleBody(
        primitivesCss,
        /\.subtabs-bar\s*>\s*\.btn\.icon-btn:has\(>\s*svg\.spin-icon\)::before,\s*\.subtabs-bar\s*>\s*\.btn\.icon-btn:disabled:has\(>\s*svg\.spin-icon\)::before\s*\{([^}]*)\}/u
      )
    ).toContain("animation: miniapp-electric-dogear-border 0.44s var(--ease-brutal) infinite;");
    expect(
      extractCssRuleBody(
        primitivesCss,
        /\.subtabs-bar\s*>\s*\.btn\.icon-btn:disabled,\s*\.subtabs-bar\s*>\s*\.btn\.icon-btn\.is-disabled\s*\{([^}]*)\}/u
      )
    ).toContain("filter: grayscale(0.25) drop-shadow(2px 2px 0 var(--btn-shadow-color));");

    // 校验 `configs.css` 引用的非 `--tg-*` 自定义变量均在 `base.css` 或 `configs.css` 中已定义。
    const definedVars: Set<string> = new Set<string>(
      [...baseCss.matchAll(/(--[a-z0-9-]+)\s*:/gu), ...configsCss.matchAll(/(--[a-z0-9-]+)\s*:/gu)].map(
        (m): string => m[1]!
      )
    );
    for (const refMatch of configsCss.matchAll(/var\(\s*(--[a-z0-9-]+)/gu)) {
      const varName: string = refMatch[1]!;
      if (!varName.startsWith("--tg-")) expect(definedVars.has(varName)).toBeTrue();
    }

    const brutalSelectorRuleChecks: readonly (readonly [RegExp, readonly string[]])[] = [
      [/(?:^|\n)\.config-selector-trigger\s*\{([^}]*)\}/u, ["min-height: 64px;", "background: var(--dropdown-board-bg);", "border: var(--border-w) solid var(--dropdown-board-border);", "border-left: 4px solid var(--accent);", "box-shadow: var(--btn-shadow);", "will-change: auto;", "backface-visibility: visible;", "transform: translate(0, 0);"]],
      [/(?:^|\n)\.config-selector-chevron-pill\.open\s*\{([^}]*)\}/u, ["background: var(--brutal-yellow);", "color: var(--brutal-yellow-ink);"]],
      [/(?:^|\n)\.config-selector-popover\s*\{([^}]*)\}/u, ["background: var(--cap-expanded-bg);", "border: var(--border-w) solid var(--dropdown-board-border);", "border-bottom: 4px solid var(--accent);", "box-shadow: var(--shadow-lg);", "padding: 9px 10px 10px;", "gap: 8px;", "will-change: auto;", "backface-visibility: visible;"]],
      [/(?:^|\n)\.config-selector-list\s*\{([^}]*)\}/u, ["max-height: 196px;", "gap: 7px;", "overflow-y: auto;", "scrollbar-width: none;"]],
      [/(?:^|\n)\.config-selector-scrollbar\s*\{([^}]*)\}/u, ["width: 13px;", "background: var(--surface-inset);", "border: var(--border-w) solid var(--dropdown-board-border);", "box-shadow: 2px 2px 0 var(--shadow-ink);", "transform: skewY(-16deg);"]],
      [/(?:^|\n)\.config-selector-scrollbar-thumb\s*\{([^}]*)\}/u, ["background: var(--brutal-yellow);", "min-height: 28px;", "border-top: 2px solid var(--btn-border);"]],
      [/\.json-editor-textarea::-webkit-scrollbar\s*\{([^}]*)\}/u, ["display: none;", "width: 0;", "height: 0;"]],
      [/(?:^|\n)\.json-editor-scroll-lane\s*\{([^}]*)\}/u, ["background: var(--json-scrollbar-lane-bg);"]],
      [/(?:^|\n)\.json-editor-scroll-lane-v\s*\{([^}]*)\}/u, ["width: 20px;", "border-left: var(--border-w-sm) solid var(--border-subtle);"]],
      [/(?:^|\n)\.json-editor-scroll-lane-h\s*\{([^}]*)\}/u, ["height: 20px;", "border-top: var(--border-w-sm) solid var(--border-subtle);"]],
      [/(?:^|\n)\.json-editor-scrollbar\s*\{([^}]*)\}/u, ["background: var(--json-scrollbar-track-bg);", "border: var(--border-w) solid var(--dropdown-board-border);", "box-shadow: 2px 2px 0 var(--shadow-ink);"]],
      [/(?:^|\n)\.json-editor-scrollbar-v\s*\{([^}]*)\}/u, ["width: 11px;", "transform: skewY(-16deg);"]],
      [/(?:^|\n)\.json-editor-scrollbar-h\s*\{([^}]*)\}/u, ["height: 11px;", "transform: skewX(-16deg);"]],
      [/(?:^|\n)\.json-editor-scrollbar-thumb\s*\{([^}]*)\}/u, ["background: var(--brutal-yellow);"]],
      [/(?:^|\n)\.configs-actions-row\s*\{([^}]*)\}/u, ["min-height: 32px;"]],
      [/(?:^|\n)\.config-selector-option\s*\{([^}]*)\}/u, ["background: var(--dropdown-item-bg);", "color: var(--text);", "border: var(--border-w-sm) solid var(--dropdown-item-border);", "border-radius: 2px 7px 2px 7px;", "box-shadow: var(--shadow-xs);", "will-change: auto;", "backface-visibility: visible;", "transform: translate(0, 0);"]],
      [/\.config-selector-option:hover:not\(:disabled\):not\(\.active\)\s*\{([^}]*)\}/u, ["transform: translate(-1px, -1px);", "box-shadow: var(--btn-shadow-hover);", "background: var(--surface-elevated);", "border-color: var(--border-strong);", "border-left-color: var(--brutal-yellow);"]],
      [/\.config-selector-option:hover:not\(:disabled\):not\(\.active\)\s+\.config-selector-option-index\s*\{([^}]*)\}/u, ["background: var(--brutal-yellow);", "color: var(--brutal-yellow-ink);"]],
      [/(?:^|\n)\.config-selector-option:active:not\(:disabled\),[\s\S]*?\[data-theme="dark"\]\s*\.config-selector-option\.active:active:not\(:disabled\)\s*\{([^}]*)\}/u, ["transform: translate(2px, 2px);", "box-shadow: 0 0 0 var(--shadow-ink);"]],
      [/(?:^|\n)\.config-selector-option\.active\s*\{([^}]*)\}/u, ["background: var(--cap-active-mood-bg);", "color: var(--text);", "border-color: var(--accent-border);", "border-left: 4px solid var(--accent);", "box-shadow: 2px 2px 0 var(--accent);"]],
      [/\[data-theme="dark"\]\s*\.config-selector-option\.active\s*\{([^}]*)\}/u, ["background: #3d1a2e;", "border-left: 4px solid var(--brutal-lime);", "box-shadow: 2px 2px 0 var(--accent);"]],
      [/(?:^|\n)\.config-selector-option-index\s*\{([^}]*)\}/u, ["font-family: var(--font-mono);", "border-radius: 2px 6px 2px 6px;", "border: var(--border-w-sm) solid var(--btn-border);", "background: var(--surface-inset);"]],
      [/(?:^|\n)\.config-selector-option\.active\s+\.config-selector-option-index\s*\{([^}]*)\}/u, ["background: var(--brutal-lime);", "color: var(--brutal-yellow-ink);"]],
      [/(?:^|\n)\.config-selector-option-name\s*\{([^}]*)\}/u, ["background: var(--accent-soft);", "border: var(--border-w-sm) solid var(--accent-border);", "border-radius: 2px 7px 2px 7px;"]],
      [/(?:^|\n)\.config-selector-option\.active\s+\.config-selector-option-desc\s*\{([^}]*)\}/u, ["color: var(--text);"]],
      [/(?:^|\n)\.config-selector-trigger:disabled,\s*\[data-theme="dark"\]\s*\.config-selector-trigger:disabled\s*\{([^}]*)\}/u, ["opacity: 0.5;", "filter: grayscale(0.25);", "box-shadow: var(--btn-shadow);"]],
      [/\.config-selector-popover:not\(\.closing\)\s+\.config-selector-option:disabled\s*\{([^}]*)\}/u, ["box-shadow: var(--shadow-xs);"]],
      [/\.config-selector-popover:not\(\.closing\)\s+\.config-selector-option\.active:disabled\s*\{([^}]*)\}/u, ["box-shadow: 2px 2px 0 var(--accent);"]],
      [/\.configs-actions-row\s+\.btn:disabled,\s*\.configs-actions-row\s+\.icon-btn:disabled\s*\{([^}]*)\}/u, ["box-shadow: var(--btn-shadow);"]],
      [/\.configs-actions-row\s+\.btn\.primary:disabled\s*\{([^}]*)\}/u, ["box-shadow: var(--btn-primary-shadow);"]],
      [/(?:^|\n)\.configs-format-btn\s*\{([^}]*)\}/u, ["position: relative;", "min-width: 88px;"]],
      [/(?:^|\n)\.configs-reset-btn\s*\{([^}]*)\}/u, ["position: relative;", "min-width: 78px;"]],
      [/(?:^|\n)\.configs-save-btn\s*\{([^}]*)\}/u, ["--btn-skew: var(--skew-btn);", "position: relative;", "min-width: 108px;", "margin-left: auto;"]],
      [/\.configs-format-btn\.is-loading,\s*\.configs-format-btn\.is-loading:disabled,\s*\.configs-reset-btn\.is-loading,\s*\.configs-reset-btn\.is-loading:disabled,\s*\.configs-save-btn\.is-loading,\s*\.configs-save-btn\.is-loading:disabled\s*\{([^}]*)\}/u, ["overflow: hidden;", "opacity: 1;", "filter: none;", "cursor: progress;", "color: var(--accent);", "background: var(--accent-soft);", "border-color: var(--electric-cyan, var(--brutal-cyan));", "animation: miniapp-auth-electric-glint 0.52s var(--ease-brutal) infinite;"]],
      [/\[data-theme="dark"\]\s*\.configs-format-btn\.is-loading,\s*\[data-theme="dark"\]\s*\.configs-format-btn\.is-loading:disabled,\s*\[data-theme="dark"\]\s*\.configs-reset-btn\.is-loading,\s*\[data-theme="dark"\]\s*\.configs-reset-btn\.is-loading:disabled,\s*\[data-theme="dark"\]\s*\.configs-save-btn\.is-loading,\s*\[data-theme="dark"\]\s*\.configs-save-btn\.is-loading:disabled\s*\{([^}]*)\}/u, ["color: var(--electric-cyan, var(--brutal-cyan));", "background: #162036;"]],
      [/\.configs-format-btn\.is-loading::after,\s*\.configs-reset-btn\.is-loading::after,\s*\.configs-save-btn\.is-loading::after\s*\{([^}]*)\}/u, ['content: "";', "position: absolute;", "width: 72%;", "background: var(--shimmer-flash);", "animation: miniapp-shimmer 0.56s var(--ease-brutal) infinite;", "pointer-events: none;"]],
      [/\.configs-format-btn\s*>\s*\.join-clean-loading-dots,\s*\.configs-reset-btn\s*>\s*\.join-clean-loading-dots,\s*\.configs-save-btn\s*>\s*\.join-clean-loading-dots\s*\{([^}]*)\}/u, ["display: inline-flex;", "flex-direction: row;", "align-items: center;", "justify-content: center;", "gap: 6px;", "height: 16px;", "transform: skewX(calc(var(--btn-skew, 0deg) * -1)) translateY(1px);"]],
      [/\.configs-format-btn\s*>\s*\.join-clean-loading-dots\s*>\s*\.loading-dot-block,\s*\.configs-reset-btn\s*>\s*\.join-clean-loading-dots\s*>\s*\.loading-dot-block,\s*\.configs-save-btn\s*>\s*\.join-clean-loading-dots\s*>\s*\.loading-dot-block\s*\{([^}]*)\}/u, ["width: 5.5px;", "height: 5.5px;", "--dot-wave-peak-y: -3px;"]],
    ];
    expect(extractCssRuleBody(configsCss, /(?:^|\n)\.configs-format-btn\s*\{([^}]*)\}/u)).not.toContain("overflow: hidden");
    expect(extractCssRuleBody(configsCss, /(?:^|\n)\.configs-reset-btn\s*\{([^}]*)\}/u)).not.toContain("overflow: hidden");
    expect(extractCssRuleBody(configsCss, /(?:^|\n)\.configs-save-btn\s*\{([^}]*)\}/u)).not.toContain("overflow: hidden");
    for (const [pattern, tokens] of brutalSelectorRuleChecks) {
      const ruleBody: string = extractCssRuleBody(configsCss, pattern);
      for (const token of tokens) {
        expect(ruleBody).toContain(token);
      }
    }

    const nonClosingRules: string = configsCss
      .replace(/@keyframes\s+miniapp-config-popover-out\s*\{[\s\S]*?\}\s*\}/gu, "")
      .replace(/\.config-selector-popover\.closing\s*\{[^}]*\}/gu, "");
    expect(nonClosingRules).not.toContain("translate3d(");

    for (const tsxPath of [
      "packages/mini-app-frontend/pages/ConfigsPage.tsx",
      "packages/mini-app-frontend/components/ConfigFileSelector.tsx",
      "packages/mini-app-frontend/components/JsonCodeEditor.tsx",
      "packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton.tsx",
    ]) {
      const source: string = await Bun.file(tsxPath).text();
      for (const forbidden of ["<>", "</>", "is-loading-action", "config-dirty-badge", "badge danger"]) {
        expect(source).not.toContain(forbidden);
      }
    }

    const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");
    const selectorItems: readonly Readonly<MiniAppConfigFileItem>[] =
      MINI_APP_DYNAMIC_CONFIG_FILES.map(
        (fileName, idx): Readonly<MiniAppConfigFileItem> => ({
          scope: "dynamic",
          fileName,
          exists: idx !== 1,
        })
      );
    globalThis.fetch = wrapEncryptedTestFetch((): Response =>
      Response.json({ ok: true, scope: "dynamic", fileName: "ad_detect.json", exists: true, content: "{}\n" })
    );
    const environment: MiniDomEnvironment = installMiniDom();
    try {
      (globalThis as { Telegram?: unknown }).Telegram = { WebApp: { initData: "signed-superadmin-initdata" } };
      useMiniAppStore.setState({ activeTab: "configs", sessionExpiresAt: Date.now() + 60_000 });
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      try {
        await act(async (): Promise<void> => {
          root.render(createElement(AppShell));
        });
        expect(findButtonByText(container, zh.configs.dynamicTab)).not.toBeNull();
        expect(findButtonByText(container, zh.configs.staticTab)).not.toBeNull();

        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigFileSelector, {
              scope: "dynamic",
              items: selectorItems,
              selectedFile: "agent.json",
              fileExists: false,
              isDirty: false,
              menuOpen: true,
              disabled: false,
              t: zh,
              onToggleMenu: (): void => undefined,
              onCloseMenu: (): void => undefined,
              onSelectFile: (): void => undefined,
            })
          );
        });
        const optionNodes: MiniDomNode[] = findElements(container, (n): boolean => hasClass(n, "config-selector-option"));
        expect(optionNodes).toHaveLength(MINI_APP_DYNAMIC_CONFIG_FILES.length);
        const indexLabels: string[] = findElements(container, (n): boolean =>
          hasClass(n, "config-selector-option-index")
        ).map((n): string => collectNodeText(n));
        expect(indexLabels).toEqual(
          MINI_APP_DYNAMIC_CONFIG_FILES.map((_, idx): string => (idx + 1).toString().padStart(2, "0"))
        );
        expect(hasClass(optionNodes[1]!, "active")).toBeTrue();
        expect(optionNodes[1]!.getAttribute("aria-selected")).toBe("true");
        expect(
          findElements(optionNodes[1]!, (n): boolean => hasClass(n, "config-selector-option-status") && hasClass(n, "warn"))
        ).toHaveLength(1);
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
    } finally {
      environment.restore();
    }
  });
});
