/**
 * Mini App 骨架屏原样逐行扫光保真、侧边抽屉合成器与布局树隔离及代码骨架严格包含边界门禁测试：
 * 1. `skeletons.css` 完整保留全站（含 `ConfigEditorSkeleton` 51 条、`StatusSkeleton` 67 条与 `ChatDetailSkeleton` 36 条）
 *    逐行 `.skeleton-line::after` `miniapp-brutal-scan 0.68s var(--ease-brutal) infinite` 扫光动画，无任何 `content: none`
 *    或 `animation: none` 抑制覆盖；`shell.css` 不含 `animation-play-state: paused`；`StatusPage` 保留 `<section class="animate-fade-in">`；
 * 2. `AppShell` 顶层 `<Fragment>` 将 `.sidebar-backdrop`、`.sidebar-drawer` 与 `Toast` 置于 `.app-shell` 之外，
 *    `.app-shell` 恒定 `display: flex; flex-direction: column;`，`.sidebar-drawer` 采用整数宽度与纯像素 `translate3d(-324px, 0, 0)`
 *    及 `.open` 悬停作用域限定，`.app-main[data-sidebar-motion="active"]` 仅屏蔽指针穿透而不暂停背景动画；
 * 3. `configs.css` 为 `.config-skeleton-code-frame` 设置 `contain: strict;`（`.config-skeleton-shell` 不挂 `position: relative;`），
 *    并在 Windows PC（`420×690`）与 Pixel 10a（`412×915`）视口下保持零高度跳变。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../../packages/mini-app-frontend/components/AppShell";
import { ChatDetailSkeleton } from "../../packages/mini-app-frontend/components/skeletons/ChatDetailSkeleton";
import { ConfigEditorSkeleton } from "../../packages/mini-app-frontend/components/skeletons/ConfigEditorSkeleton";
import { StatusSkeleton } from "../../packages/mini-app-frontend/components/skeletons/StatusSkeleton";
import {
  MINI_APP_FEATURE_KEYS,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS,
  MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES,
  MINI_APP_STATUS_SKELETON_MEMORY_INDICES,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_CONFIG_SKELETON_LINE_INDICES,
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../../packages/mini-app-frontend/consts/miniAppConfig";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { StatusPage } from "../../packages/mini-app-frontend/pages/StatusPage";
import {
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
import type {
  MiniAppConfigFileItem,
  MiniAppStatusView,
} from "../../packages/mini-app-frontend/types/miniApp";
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

/** 模拟视口尺寸与安全区规格。 */
interface ViewportCssEnvSpec {
  readonly label: string;
  readonly stableHeight: number;
  readonly safeAreaTop: number;
  readonly safeAreaBottom: number;
}

const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

/** Windows PC 默认窗口（420×690）与 Pixel 10a 全屏视口（412×915）Telegram WebApp CSS 环境变量。 */
const TARGET_VIEWPORT_SPECS: readonly Readonly<ViewportCssEnvSpec>[] = [
  {
    label: "Windows PC Default (420x690)",
    stableHeight: 690,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  },
  {
    label: "Pixel 10a Full-Screen (412x915)",
    stableHeight: 915,
    safeAreaTop: 44,
    safeAreaBottom: 20,
  },
];

/** 剥离 CSS 注释后按正则提取规则声明体。 */
function extractCssRuleBody(css: string, selectorPattern: RegExp): string {
  const stripped: string = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return selectorPattern.exec(stripped)?.[1] ?? "";
}

/** 构造配置目录列表测试响应。 */
function buildConfigsCatalogResponse(): Response {
  const dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[] =
    MINI_APP_DYNAMIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "dynamic",
        fileName,
        exists: true,
      })
    );
  const staticFiles: readonly Readonly<MiniAppConfigFileItem>[] =
    MINI_APP_STATIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "static",
        fileName,
        exists: true,
      })
    );
  return Response.json({ ok: true, dynamicFiles, staticFiles });
}

/** 构造实时状态快照夹具。 */
function buildStatusViewFixture(): Readonly<MiniAppStatusView> {
  return {
    generatedAt: 1_700_000_000_000,
    uptimeMs: 120_000,
    cpuAveragePercent: 18.4,
    memoryPeakRssBytes: 96 * 1024 * 1024,
    memoryCurrentRssBytes: 64 * 1024 * 1024,
    memoryOtherBytes: 16 * 1024 * 1024,
    memoryTotalBytes: 48 * 1024 * 1024,
    memoryHeapUsedBytes: 32 * 1024 * 1024,
    managedChatCount: 4,
    whitelistCount: 6,
    blocklistCount: 2,
    activeSessions: { total: 1, gag: 1, wed: 0, verify: 0, qaSet: 0 },
    telegramOutbound: {
      inFlight: 1,
      retryWaiting: 0,
      retryQueueMax: 32,
    },
    capabilities: [
      {
        key: "mood",
        label: "Mood",
        ready: true,
        detail: "ready",
        items: [{ label: "Current", value: "calm" }],
      },
    ],
  };
}

/** 排空异步加密传输微任务并推进最短骨架驻留时长。 */
async function flushEncryptedLoadingWindow(): Promise<void> {
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
  seedTestMiniAppSession(
    "b".repeat(64),
    Date.now() + 600_000,
    TEST_SESSION_KEY
  );
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

describe("骨架屏原样逐行扫光保真、侧边抽屉合成器与布局隔离及代码骨架 contain: strict", () => {
  test("skeletons.css、shell.css 与 StatusPage 100% 保留原始逐行 .skeleton-line::after 扫光且侧栏开合绝不暂停背景动画", async () => {
    const skeletonsCss: string = await Bun.file(
      "packages/mini-app-frontend/styles/skeletons.css"
    ).text();
    const shellCss: string = await Bun.file(
      "packages/mini-app-frontend/styles/shell.css"
    ).text();

    // 1. 核验 ConfigEditorSkeleton（51 条，不含隐藏按钮骨架）、StatusSkeleton（67 条）与 ChatDetailSkeleton（36 条）全部 `.skeleton-line` 原样保留。
    const countSkeletonLines = (markup: string): number =>
      [...markup.matchAll(/class="([^"]*)"/gu)].filter(
        (m: RegExpExecArray): boolean =>
          (m[1] ?? "").split(/\s+/u).includes("skeleton-line")
      ).length;

    const expectedConfigLines: number =
      2 + MINI_APP_CONFIG_SKELETON_LINE_INDICES.length * 2 + 1;
    const expectedStatusLines: number =
      21 +
      MINI_APP_STATUS_SKELETON_MEMORY_INDICES.length * 5 +
      1 +
      MINI_APP_STATUS_SKELETON_CAPABILITY_INDICES.length * 5;
    const expectedChatDetailLines: number =
      8 + MINI_APP_FEATURE_KEYS.length * 4;
    const configSkeletonMarkup: string = renderToStaticMarkup(
      createElement(ConfigEditorSkeleton)
    );
    expect(countSkeletonLines(configSkeletonMarkup)).toBe(expectedConfigLines);
    expect(configSkeletonMarkup).not.toContain("config-skeleton-btn-primary");
    expect(
      [...configSkeletonMarkup.matchAll(/\bconfig-skeleton-btn-sm\b/gu)]
    ).toHaveLength(1);
    expect(countSkeletonLines(renderToStaticMarkup(createElement(StatusSkeleton)))).toBe(
      expectedStatusLines
    );
    expect(countSkeletonLines(renderToStaticMarkup(createElement(ChatDetailSkeleton)))).toBe(
      expectedChatDetailLines
    );

    // 2. 所有 `.skeleton-line` 统一使用 `.skeleton-line::after` 逐行扫光规则，不含任何 `content: none` 或 `animation: none` 覆盖声明。
    const baseLineAfterBody: string = extractCssRuleBody(
      skeletonsCss,
      /\.skeleton-line::after,\s*\.gallery-img-skeleton::after\s*\{([^}]*)\}/u
    );
    expect(baseLineAfterBody).toContain('content: "";');
    expect(baseLineAfterBody).toContain("background: var(--skeleton-scan-band);");
    expect(baseLineAfterBody).toContain(
      "animation: miniapp-brutal-scan 0.68s var(--ease-brutal) infinite;"
    );
    expect(baseLineAfterBody).not.toContain("will-change");

    const strippedSkeletonsCss: string = skeletonsCss.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(strippedSkeletonsCss).not.toContain("content: none");
    expect(strippedSkeletonsCss).not.toContain("animation: none");
    expect(strippedSkeletonsCss).not.toContain(".config-editor-skeleton");
    expect(strippedSkeletonsCss).not.toContain(".config-skeleton-shell");
    expect(strippedSkeletonsCss).not.toMatch(/\.skeleton-detail-wrap\s+\.skeleton-line::after/u);
    expect(strippedSkeletonsCss).not.toMatch(/\.skeleton-detail-wrap\s*>\s*\.card/u);
    expect(strippedSkeletonsCss).not.toContain("999px");
    expect(strippedSkeletonsCss).not.toMatch(/(?<![\w-])scroll-behavior\s*:/u);

    // 3. `shell.css` 绝不使用 `animation-play-state: paused` 冻结 `.app-main` 内可见骨架动画。
    const strippedShellCss: string = shellCss.replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(strippedShellCss).not.toContain("animation-play-state");

    // 4. `StatusPage` 在 SSR、初次加载、快照落定与手动刷新全生命周期完整保留外层 `<section class="animate-fade-in">`。
    const ssrMarkup: string = renderToStaticMarkup(createElement(StatusPage));
    expect(ssrMarkup.startsWith('<section class="animate-fade-in"><div class="toolbar">')).toBeTrue();
    expect(ssrMarkup).toContain("skeleton-detail-wrap");

    let pendingStatusResolve: ((response: Response) => void) | null = null;
    let interceptRefresh: boolean = false;
    globalThis.fetch = wrapEncryptedTestFetch(
      (url: URL): Response | Promise<Response> => {
        if (url.pathname === "/api/mood") {
          return Response.json({ ok: true, available: true, currentMood: "calm" });
        }
        if (url.pathname === "/api/status") {
          if (interceptRefresh) {
            return new Promise<Response>((resolve): void => {
              pendingStatusResolve = resolve;
            });
          }
          return Response.json(buildStatusViewFixture());
        }
        return Response.json({ error: "not found" }, 404);
      }
    );

    jest.useFakeTimers();
    const environment: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      try {
        await act(async (): Promise<void> => {
          root.render(createElement(StatusPage));
        });

        const outerSection: MiniDomNode | undefined = findElements(
          container,
          (node): boolean => node.tagName === "SECTION"
        )[0];
        expect(outerSection).toBeDefined();
        expect(hasClass(outerSection!, "animate-fade-in")).toBeTrue();
        expect(
          findElements(container, (node): boolean => hasClass(node, "skeleton-detail-wrap"))
        ).toHaveLength(1);

        await flushEncryptedLoadingWindow();
        expect(hasClass(outerSection!, "animate-fade-in")).toBeTrue();
        expect(
          findElements(container, (node): boolean => hasClass(node, "skeleton-detail-wrap"))
        ).toHaveLength(0);
        const fadeDivWrappers: MiniDomNode[] = findElements(
          container,
          (node): boolean => node.tagName === "DIV" && hasClass(node, "animate-fade-in")
        );
        expect(fadeDivWrappers).toHaveLength(1);
        expect(collectNodeText(fadeDivWrappers[0]!)).toContain(
          zh.status.capabilitiesSectionTitle
        );

        interceptRefresh = true;
        const refreshButton: MiniDomNode | null = findButtonByText(
          container,
          zh.chats.refreshButton
        );
        expect(refreshButton).not.toBeNull();
        await act(async (): Promise<void> => {
          refreshButton!.triggerClick();
        });
        expect(hasClass(outerSection!, "animate-fade-in")).toBeTrue();
        expect(
          findElements(container, (node): boolean => hasClass(node, "skeleton-detail-wrap"))
        ).toHaveLength(1);

        interceptRefresh = false;
        expect(pendingStatusResolve).not.toBeNull();
        const resolveRefresh: (response: Response) => void = pendingStatusResolve!;
        resolveRefresh(Response.json(buildStatusViewFixture()));
        await flushEncryptedLoadingWindow();
        expect(hasClass(outerSection!, "animate-fade-in")).toBeTrue();
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
    } finally {
      jest.useRealTimers();
      environment.restore();
    }
  });

  test("侧边栏合成器与布局隔离（Fragment 同级、恒定 flex 壳层、纯像素位移、.open 悬停限定）及 .config-skeleton-code-frame contain: strict 零高度跳变", async () => {
    const baseCss: string = await Bun.file(
      "packages/mini-app-frontend/styles/base.css"
    ).text();
    const shellCss: string = await Bun.file(
      "packages/mini-app-frontend/styles/shell.css"
    ).text();
    const configsCss: string = await Bun.file(
      "packages/mini-app-frontend/styles/configs.css"
    ).text();

    // 1. 侧边抽屉与主壳层 CSS 合成器与布局树隔离契约。
    const appShellBody: string = extractCssRuleBody(
      shellCss,
      /(?:^|\n)\.app-shell\s*\{([^}]*)\}/u
    );
    expect(appShellBody).toContain("display: flex;");
    expect(appShellBody).toContain("flex-direction: column;");

    const appMainMotionBody: string = extractCssRuleBody(
      shellCss,
      /\.app-main\[data-sidebar-motion="active"\]\s*\{([^}]*)\}/u
    );
    expect(appMainMotionBody).toContain("pointer-events: none;");
    expect(appMainMotionBody).not.toContain("animation-play-state");

    const sidebarDrawerBody: string = extractCssRuleBody(
      shellCss,
      /(?:^|\n)\.sidebar-drawer\s*\{([^}]*)\}/u
    );
    expect(sidebarDrawerBody).toContain("width: round(nearest, min(312px, 86vw), 1px);");
    expect(sidebarDrawerBody).toContain("will-change: transform;");
    expect(sidebarDrawerBody).toContain("backface-visibility: hidden;");
    expect(sidebarDrawerBody).toContain("transform: translate3d(-324px, 0, 0);");
    expect(sidebarDrawerBody).not.toMatch(/transform\s*:[^;]*(?:%|calc\()/u);
    const transitionSecondsMatch: RegExpExecArray | null =
      /transition\s*:\s*transform\s+([0-9.]+)s\s+var\(--ease-brutal\)/u.exec(
        sidebarDrawerBody
      );
    expect(transitionSecondsMatch).not.toBeNull();
    const cssDrawerTransitionMs: number = Math.round(
      Number(transitionSecondsMatch![1]) * 1_000
    );
    expect(MINI_APP_SIDEBAR_CLOSE_ANIMATION_MS).toBeGreaterThan(cssDrawerTransitionMs);

    expect(shellCss).toContain(
      ".sidebar-drawer.open .sidebar-nav-item:hover:not(:disabled):not(.active)"
    );
    expect(shellCss).not.toMatch(/(?:^|\n|\{\s*)\.sidebar-nav-item:hover\b/u);
    expect(
      extractCssRuleBody(
        shellCss,
        /\.sidebar-drawer:not\(\.open\)\s+\.sidebar-nav-item[^{]*\{([^}]*)\}/u
      )
    ).toContain("transition: none;");

    // 2. `.config-skeleton-shell` 不挂 `position: relative;`，`.config-skeleton-code-frame` 保持 `contain: strict;`。
    const shellRuleBody: string = extractCssRuleBody(
      configsCss,
      /(?:^|\n)\.config-skeleton-shell\s*\{([^}]*)\}/u
    );
    expect(shellRuleBody).not.toContain("position: relative;");
    expect(shellRuleBody).toContain("flex: 1 1 0%;");
    expect(shellRuleBody).toContain("min-height: 240px;");
    expect(shellRuleBody).toContain("overflow: hidden;");

    const codeFrameBody: string = extractCssRuleBody(
      configsCss,
      /(?:^|\n)\.config-skeleton-code-frame\s*\{([^}]*)\}/u
    );
    expect(codeFrameBody).toContain("position: relative;");
    expect(codeFrameBody).toContain("flex: 1 1 0%;");
    expect(codeFrameBody).toContain("min-height: 0;");
    expect(codeFrameBody).toContain("overflow: hidden;");
    expect(codeFrameBody).toContain("contain: strict;");
    expect(
      extractCssRuleBody(
        configsCss,
        /(?:^|\n)\.config-skeleton-actions\s*\{([^}]*)\}/u
      )
    ).toContain("min-height: 32px;");
    expect(
      extractCssRuleBody(
        configsCss,
        /(?:^|\n)\.skeleton-line\.config-skeleton-btn-primary\s*\{([^}]*)\}/u
      )
    ).toContain("transform: skewX(var(--skew-btn));");

    expect(configsCss).not.toContain("--skeleton-");
    expect(configsCss).not.toContain(":has(");
    expect(configsCss).not.toMatch(
      /transition\s*:[^;]*(?:\btransform\b|\bfilter\b)/u
    );
    const definedVars: Set<string> = new Set<string>(
      [
        ...baseCss.matchAll(/(--[a-z0-9-]+)\s*:/gu),
        ...configsCss.matchAll(/(--[a-z0-9-]+)\s*:/gu),
      ].map((m: RegExpExecArray): string => m[1]!)
    );
    for (const refMatch of configsCss.matchAll(/var\(\s*(--[a-z0-9-]+)/gu)) {
      const varName: string = refMatch[1]!;
      if (!varName.startsWith("--tg-")) {
        expect(definedVars.has(varName)).toBeTrue();
      }
    }

    // 3. 客户端挂载核验顶层 `<Fragment>` 同级隔离与 `420×690` / `412×915` 视口零高度跳变。
    globalThis.fetch = wrapEncryptedTestFetch((url: URL): Response => {
      if (url.pathname === "/api/configs") {
        return buildConfigsCatalogResponse();
      }
      if (url.pathname === "/api/configs/file") {
        return Response.json({
          ok: true,
          scope: url.searchParams.get("scope") ?? "dynamic",
          fileName: url.searchParams.get("fileName") ?? "ad_detect.json",
          exists: true,
          content: '{\n  "enabled": true\n}\n',
        });
      }
      return Response.json({ error: "not found" }, 404);
    });

    for (const spec of TARGET_VIEWPORT_SPECS) {
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

        useMiniAppStore.setState({
          activeTab: "configs",
          sidebarOpen: false,
          sessionExpiresAt: Date.now() + 600_000,
        });

        const container: MiniDomNode =
          environment.document.createElement("div");
        const root: Root = createRoot(container as unknown as Element);
        try {
          await act(async (): Promise<void> => {
            root.render(createElement(AppShell));
          });

          const appShellNode: MiniDomNode = findElements(container, (node): boolean =>
            hasClass(node, "app-shell")
          )[0]!;
          const backdropNode: MiniDomNode = findElements(container, (node): boolean =>
            hasClass(node, "sidebar-backdrop")
          )[0]!;
          const drawerNode: MiniDomNode = findElements(container, (node): boolean =>
            hasClass(node, "sidebar-drawer")
          )[0]!;
          expect(appShellNode.parentNode).toBe(container);
          expect(backdropNode.parentNode).toBe(container);
          expect(drawerNode.parentNode).toBe(container);
          expect(appShellNode.contains(backdropNode)).toBeFalse();
          expect(appShellNode.contains(drawerNode)).toBeFalse();

          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "config-skeleton-shell")
            )
          ).toHaveLength(1);
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
              hasClass(node, "config-skeleton-code-frame")
            )
          ).toHaveLength(1);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "config-skeleton-actions")
            )
          ).toHaveLength(1);

          await flushEncryptedLoadingWindow();

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

          const baseCss: string = await readStrippedCss("packages/mini-app-frontend/styles/base.css");
          const shellCss: string = await readStrippedCss("packages/mini-app-frontend/styles/shell.css");
          const configsCss: string = await readStrippedCss("packages/mini-app-frontend/styles/configs.css");

          const bodyRule: string = extractCssBlockBody(baseCss, /(?:^|\n)body\s*\{([^}]*)\}/u);
          const paddingMatch: RegExpExecArray | null =
            /padding\s*:\s*calc\(\s*(\d+)px[\s\S]*?calc\(\s*(\d+)px/u.exec(bodyRule);
          expect(paddingMatch).not.toBeNull();
          const bodyTopPx: number = Number(paddingMatch![1]);
          const bodyBottomPx: number = Number(paddingMatch![2]);

          const shellConfigsRule: string = extractCssBlockBody(
            shellCss,
            /\.app-shell\.app-shell-configs\s*\{([^}]*)\}/u
          );
          expect(shellConfigsRule).toContain("display: flex;");
          expect(shellConfigsRule).toContain("flex-direction: column;");
          const shellMarginMatch: RegExpExecArray | null =
            /margin-bottom\s*:\s*(-?\d+)px\s*;/u.exec(shellConfigsRule);
          const shellSubMatch: RegExpExecArray | null =
            /min-height\s*:\s*calc\([\s\S]*?-\s*(\d+)px\s*-/u.exec(shellConfigsRule);
          expect(shellMarginMatch).not.toBeNull();
          expect(shellSubMatch).not.toBeNull();
          expect(bodyTopPx + bodyBottomPx + Number(shellMarginMatch![1])).toBe(
            Number(shellSubMatch![1])
          );

          const mainConfigsRule: string = extractCssBlockBody(
            shellCss,
            /\.app-main\.app-main-configs\s*\{([^}]*)\}/u
          );
          expect(mainConfigsRule).toContain("flex: 1 1 auto;");
          expect(mainConfigsRule).toContain("display: flex;");
          expect(mainConfigsRule).toContain("flex-direction: column;");

          const configsPageRule: string = extractCssBlockBody(configsCss, /(?:^|\n)\.configs-page\s*\{([^}]*)\}/u);
          expect(configsPageRule).toContain("flex: 1 1 auto;");
          expect(configsPageRule).toContain("display: flex;");
          expect(configsPageRule).toContain("flex-direction: column;");

          const editorCardRule: string = extractCssBlockBody(configsCss, /\.configs-editor-card\s*\{([^}]*)\}/u);
          const skeletonCardRule: string = extractCssBlockBody(configsCss, /\.config-editor-skeleton\s*\{([^}]*)\}/u);
          for (const rule of [editorCardRule, skeletonCardRule]) {
            expect(rule).toContain("flex: 1 1 auto;");
            expect(rule).toContain("display: flex;");
            expect(rule).toContain("flex-direction: column;");
            expect(rule).toContain("gap: 10px;");
            expect(rule).toContain("padding: 12px;");
            expect(rule).toContain("margin-bottom: 0;");
          }

          const editorFrameRule: string = extractCssBlockBody(configsCss, /\.json-editor-frame\s*\{([^}]*)\}/u);
          const skeletonShellRule: string = extractCssBlockBody(configsCss, /\.config-skeleton-shell\s*\{([^}]*)\}/u);
          const minFrameHeight: string = /min-height\s*:\s*(\d+px)\s*;/u.exec(editorFrameRule)?.[1] ?? "";
          expect(minFrameHeight).toBe("240px");
          expect(editorFrameRule).toContain("flex: 1 1 0%;");
          expect(skeletonShellRule).toContain("flex: 1 1 0%;");
          expect(/min-height\s*:\s*(\d+px)\s*;/u.exec(skeletonShellRule)?.[1]).toBe(minFrameHeight);

          const actionsRowRule: string = extractCssBlockBody(configsCss, /(?:^|\n)\.configs-actions-row\s*\{([^}]*)\}/u);
          const skeletonActionsRule: string = extractCssBlockBody(configsCss, /\.config-skeleton-actions\s*\{([^}]*)\}/u);
          const actionsMinHeight: string = /min-height\s*:\s*(\d+px)\s*;/u.exec(actionsRowRule)?.[1] ?? "";
          expect(actionsMinHeight).toBe("32px");
          expect(/min-height\s*:\s*(\d+px)\s*;/u.exec(skeletonActionsRule)?.[1]).toBe(actionsMinHeight);
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
  });
});
