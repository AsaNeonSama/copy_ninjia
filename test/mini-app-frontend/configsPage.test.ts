/**
 * Mini App 「配置编辑」页面（单行动态/静态子标签、文件下拉选择器、双主题 JSON 语法高亮编辑器、
 * 已有文件脏检查门禁、底部动作按钮三点忙碌动效与显隐骨架过渡、会话临时密钥直接加密保存与静态配置保存后服务重启专属按钮确认流）集成测试。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../../packages/mini-app-frontend/components/AppShell";
import { ConfirmModal } from "../../packages/mini-app-frontend/components/ConfirmModal";
import {
  MINI_APP_CONFIRM_CLOSE_ANIMATION_MS,
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_LANGUAGES,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_TAB_KEYS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_CONFIG_SKELETON_LINE_INDICES,
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_MAX_CONFIG_CONTENT_BYTES,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../../packages/mini-app-frontend/consts/miniAppConfig";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import {
  isMiniAppEncryptedEnvelope,
} from "../../packages/mini-app-frontend/libs/crypto";
import { ConfigsPage } from "../../packages/mini-app-frontend/pages/ConfigsPage";
import {
  resetMiniAppStoreForTest,
  useMiniAppStore,
} from "../../packages/mini-app-frontend/store/app";
import { createConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import type { MiniAppConfigsStore } from "../../packages/mini-app-frontend/store/configs";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigSaveRequest,
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

type RouteHandler = (
  url: URL,
  decryptedInit: RequestInit | undefined,
  rawInit: RequestInit | undefined
) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const fetchLog: string[] = [];
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function jsonRes(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

function isDisabledNode(node: MiniDomNode | null): boolean {
  return node?.getAttribute("disabled") !== null;
}

function findSaveButton(container: MiniDomNode): MiniDomNode | null {
  return (
    findElements(
      container,
      (node): boolean =>
        node.tagName === "BUTTON" &&
        hasClass(node, "configs-save-btn") &&
        collectNodeText(node).includes(zh.configs.saveButton)
    )[0] ?? null
  );
}

function countClassNodes(container: MiniDomNode, className: string): number {
  return findElements(container, (node): boolean => hasClass(node, className))
    .length;
}

function expectActionButtonSkeletons(
  container: MiniDomNode,
  resetSkeleton: boolean,
  saveSkeleton: boolean
): void {
  expect(countClassNodes(container, "config-skeleton-btn-sm")).toBe(
    resetSkeleton ? 1 : 0
  );
  expect(countClassNodes(container, "config-skeleton-btn-primary")).toBe(
    saveSkeleton ? 1 : 0
  );
}

function expectInFlightDotsButton(container: MiniDomNode, className: string): void {
  const btn: MiniDomNode | undefined = findElements(
    container,
    (node): boolean => hasClass(node, className)
  )[0];
  expect(btn).toBeDefined();
  expect(hasClass(btn!, "is-loading")).toBeTrue();
  expect(btn!.getAttribute("aria-busy")).toBe("true");
  expect(isDisabledNode(btn!)).toBeTrue();
  expect(collectNodeText(btn!)).toBe("");
  expect(
    findElements(
      btn!,
      (node): boolean =>
        hasClass(node, "join-clean-loading-dots") && hasClass(node, "loading-dots-wave")
    )
  ).toHaveLength(1);
  expect(
    findElements(btn!, (node): boolean => node.tagName.toUpperCase() === "SVG")
  ).toHaveLength(0);
}

function advanceActionRevealWindow(): void {
  act((): void => {
    jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS + 10);
  });
}

function buildCatalogFixture(
  missingFiles: readonly string[] = []
): Readonly<{
  readonly ok: true;
  readonly dynamicFiles: readonly Readonly<MiniAppConfigFileItem>[];
  readonly staticFiles: readonly Readonly<MiniAppConfigFileItem>[];
}> {
  return {
    ok: true,
    dynamicFiles: MINI_APP_DYNAMIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "dynamic",
        fileName,
        exists: !missingFiles.includes(fileName),
      })
    ),
    staticFiles: MINI_APP_STATIC_CONFIG_FILES.map(
      (fileName): Readonly<MiniAppConfigFileItem> => ({
        scope: "static",
        fileName,
        exists: !missingFiles.includes(fileName),
      })
    ),
  };
}

async function withMountedConfigsPage(
  store: MiniAppConfigsStore,
  run: (
    container: MiniDomNode,
    settle: () => Promise<void>
  ) => Promise<void>
): Promise<void> {
  jest.useFakeTimers();
  const environment: MiniDomEnvironment = installMiniDom();
  try {
    const container: MiniDomNode = environment.document.createElement("div");
    const root: Root = createRoot(container as unknown as Element);

    const flushIo = async (): Promise<void> => {
      for (let i: number = 0; i < 8; i += 1) {
        Bun.sleepSync(2);
        await new Promise<void>((resolve: () => void): void => {
          setImmediate(resolve);
        });
      }
    };

    const settle = async (): Promise<void> => {
      await act(async (): Promise<void> => {
        await flushIo();
        jest.advanceTimersByTime(
          Math.max(MINI_APP_MIN_LOADING_MS, MINI_APP_CONFIRM_CLOSE_ANIMATION_MS) + 20
        );
        await flushIo();
      });
    };

    try {
      await act(async (): Promise<void> => {
        root.render(
          createElement(
            Fragment,
            null,
            createElement(ConfigsPage, {
              storeFactory: (): MiniAppConfigsStore => store,
            }),
            createElement(ConfirmModal)
          )
        );
      });
      await run(container, settle);
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

beforeEach((): void => {
  routes.clear();
  fetchLog.length = 0;
  (globalThis as { Telegram?: unknown }).Telegram = {
    WebApp: { initData: "signed-superadmin-initdata" },
  };
  seedTestMiniAppSession("a".repeat(64), Date.now() + 600_000, TEST_SESSION_KEY);
  globalThis.fetch = wrapEncryptedTestFetch(
    (
      url: URL,
      decryptedInit: RequestInit | undefined,
      rawInit: RequestInit | undefined
    ): Response | Promise<Response> => {
      const method: string = (rawInit?.method ?? "GET").toUpperCase();
      const key: string = `${method} ${url.pathname}`;
      fetchLog.push(`${key}${url.search}`);
      const handler: RouteHandler | undefined = routes.get(key);
      if (handler === undefined) {
        return jsonRes({ error: `Unhandled ${key}` }, 404);
      }
      return handler(url, decryptedInit, rawInit);
    }
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

describe("配置编辑页面交互、单行子标签与加密保存流", () => {
  test("侧边栏将「配置编辑」紧跟在「权限控制」下方，切至 configs 标签页挂载全视口修饰类与密集骨架屏", () => {
    const identitiesIdx: number = MINI_APP_TAB_KEYS.indexOf("identities");
    const configsIdx: number = MINI_APP_TAB_KEYS.indexOf("configs");
    expect(identitiesIdx).toBeGreaterThanOrEqual(0);
    expect(configsIdx).toBe(identitiesIdx + 1);

    useMiniAppStore.setState({
      sidebarOpen: true,
      activeTab: "configs",
      sessionExpiresAt: Date.now() + 60_000,
    });
    const shellHtml: string = renderToStaticMarkup(createElement(AppShell));
    expect(shellHtml).toContain("app-shell app-shell-configs");
    expect(shellHtml).toContain("app-main app-main-configs");
    expect(shellHtml).toContain(zh.tabs.configs);
    expect(shellHtml).toContain(zh.tabDescriptions.configs);
    expect(shellHtml).toContain("config-editor-skeleton");
  });

  test("三语言下均无作用域说明块与工具栏重启按钮，切换「动态配置 / 静态配置」保持单行三按钮结构", async () => {
    route("GET /api/configs", (): Response => jsonRes(buildCatalogFixture()));
    route("GET /api/configs/file", (url: URL): Response => {
      const scope: string = url.searchParams.get("scope") ?? "dynamic";
      const fileName: string = url.searchParams.get("fileName") ?? "ad_detect.json";
      return jsonRes({
        ok: true,
        scope,
        fileName,
        exists: true,
        content: '{"ok": true}\n',
      });
    });

    const removedI18nKeys: readonly string[] = [
      "dynamicHint",
      "staticHint",
      "restartServiceButton",
      "confirmRestartService",
      "fileSelectorLabel",
      "savingButton",
      "restartingServiceButton",
    ];
    const removedTextSnippets: readonly string[] = [
      "无需重启服务",
      "启动参数与鉴权凭据生效",
      "without restarting",
      "apply startup settings",
      "ホットリロード反映",
      "新しい起動設定が反映",
      "重启服务",
      "Restart Service",
      "サービス再起動",
    ];

    for (const lang of MINI_APP_LANGUAGES) {
      useMiniAppStore.getState().setLanguage(lang);
      const dict: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      const configsDictRecord: Readonly<Record<string, unknown>> =
        dict.configs as unknown as Readonly<Record<string, unknown>>;
      for (const removedKey of removedI18nKeys) {
        expect(Object.hasOwn(configsDictRecord, removedKey)).toBeFalse();
      }

      const store: MiniAppConfigsStore = createConfigsStore();
      await withMountedConfigsPage(store, async (container, settle): Promise<void> => {
        await settle();

        for (const targetScope of ["dynamic", "static"] as const) {
          if (store.getState().scope !== targetScope) {
            const tabLabel: string =
              targetScope === "static"
                ? dict.configs.staticTab
                : dict.configs.dynamicTab;
            const tabBtn: MiniDomNode | null = findButtonByText(container, tabLabel);
            expect(tabBtn).not.toBeNull();
            act((): void => {
              tabBtn?.triggerClick();
            });
            await settle();
          }

          expect(store.getState().scope).toBe(targetScope);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "configs-scope-hint")
            )
          ).toHaveLength(0);
          expect(
            findElements(container, (node): boolean =>
              hasClass(node, "configs-restart-btn")
            )
          ).toHaveLength(0);

          const subtabsBars: MiniDomNode[] = findElements(container, (node): boolean =>
            hasClass(node, "configs-subtabs-bar")
          );
          expect(subtabsBars).toHaveLength(1);
          const barButtons: MiniDomNode[] = findElements(
            subtabsBars[0]!,
            (node): boolean => node.tagName === "BUTTON"
          );
          // 无论处于「动态配置」还是「静态配置」，顶栏恒为「动态子页签 + 静态子页签 + 刷新」共 3 枚按钮。
          expect(barButtons).toHaveLength(3);

          const fullText: string = collectNodeText(container);
          for (const snippet of removedTextSnippets) {
            expect(fullText).not.toContain(snippet);
          }
        }
      });
    }
  });

  test("动态配置加载、JSON 词法高亮着色、下拉切换文件、未保存离开确认拦截与会话临时密钥直接加密保存", async () => {
    const initialAdDetect: string =
      '{\n  "enabled": true,\n  "threshold": 0.85,\n  "note": null,\n  "tags": ["spam"]\n}\n';
    const initialAgent: string = '{\n  "model": "gpt-4o"\n}\n';

    route("GET /api/configs", (): Response => jsonRes(buildCatalogFixture(["mood.json"])));
    route("GET /api/configs/file", (url: URL): Response => {
      const fileName: string = url.searchParams.get("fileName") ?? "";
      if (fileName === "ad_detect.json") {
        return jsonRes({
          ok: true,
          scope: "dynamic",
          fileName: "ad_detect.json",
          exists: true,
          content: initialAdDetect,
        });
      }
      if (fileName === "mood.json") {
        return jsonRes({
          ok: true,
          scope: "dynamic",
          fileName: "mood.json",
          exists: false,
          content: "",
        });
      }
      return jsonRes({
        ok: true,
        scope: "dynamic",
        fileName: "agent.json",
        exists: true,
        content: initialAgent,
      });
    });

    let capturedOuterBody: string = "";
    let capturedSaveReq: MiniAppConfigSaveRequest | null = null;
    let releasePendingSave: (() => void) | null = null;

    route(
      "POST /api/configs/save",
      async (
        _url: URL,
        decryptedInit: RequestInit | undefined,
        rawInit: RequestInit | undefined
      ): Promise<Response> => {
        capturedOuterBody = String(rawInit?.body ?? "");
        capturedSaveReq = JSON.parse(
          String(decryptedInit?.body ?? "{}")
        ) as MiniAppConfigSaveRequest;
        return new Promise<Response>((resolve: (res: Response) => void): void => {
          releasePendingSave = (): void => {
            resolve(
              jsonRes({
                ok: true,
                scope: capturedSaveReq!.scope,
                fileName: capturedSaveReq!.fileName,
                requiresRestart: false,
              })
            );
          };
        });
      }
    );

    const store: MiniAppConfigsStore = createConfigsStore();

    await withMountedConfigsPage(store, async (container, settle): Promise<void> => {
      expect(
        findElements(container, (node): boolean =>
          hasClass(node, "config-editor-skeleton")
        )
      ).toHaveLength(1);
      expect(
        findElements(container, (node): boolean =>
          hasClass(node, "config-skeleton-line-row")
        )
      ).toHaveLength(MINI_APP_CONFIG_SKELETON_LINE_INDICES.length);
      await settle();

      // 未作修改时「还原修改」与「保存」均处于隐藏状态（不渲染）。
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();

      // 核验 JSON 全部词法类别 span 均已着色渲染。
      for (const tokClass of [
        "json-tok-key",
        "json-tok-string",
        "json-tok-number",
        "json-tok-boolean",
        "json-tok-null",
        "json-tok-brace",
        "json-tok-punct",
      ]) {
        expect(
          findElements(container, (node): boolean => hasClass(node, tokClass))
            .length
        ).toBeGreaterThan(0);
      }

      // 未修改时点击「格式化」展开单行数组：先播格式化三点动效，产生修改后对「还原修改」与「保存」播显现骨架，点击还原播三点后直接退场。
      act((): void => { findButtonByText(container, zh.configs.formatButton)?.triggerClick(); });
      expectInFlightDotsButton(container, "configs-format-btn");
      expectActionButtonSkeletons(container, false, false);
      await settle();
      expectActionButtonSkeletons(container, true, true);
      advanceActionRevealWindow();
      act((): void => { findButtonByText(container, zh.configs.resetButton)?.triggerClick(); });
      expectInFlightDotsButton(container, "configs-reset-btn");
      await settle();
      expectActionButtonSkeletons(container, false, false);

      // 修改草稿后产生未保存标记，先播放隐藏动作按钮骨架，推进 MINI_APP_MIN_LOADING_MS 后真实按钮就位；继续编辑与保持脏态的 formatDraft 不重复触发骨架。
      act((): void => { store.getState().setDraftContent('{"enabled":false,"threshold":0.8}'); });
      expect(collectNodeText(container)).toContain(zh.configs.dirtyBadge);
      expectActionButtonSkeletons(container, true, true);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();

      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(isDisabledNode(findButtonByText(container, zh.configs.resetButton))).toBeFalse();
      expect(isDisabledNode(findSaveButton(container))).toBeFalse();

      act((): void => { store.getState().setDraftContent('{"enabled":false,"threshold":0.9}'); });
      expectActionButtonSkeletons(container, false, false);

      act((): void => { findButtonByText(container, zh.configs.formatButton)?.triggerClick(); });
      expect(store.getState().formatting).toBeTrue();
      expectActionButtonSkeletons(container, false, false);
      expectInFlightDotsButton(container, "configs-format-btn");
      expect(isDisabledNode(findButtonByText(container, zh.configs.resetButton))).toBeTrue();
      expect(isDisabledNode(findSaveButton(container))).toBeTrue();
      await settle();
      expect(store.getState().formatting).toBeFalse();
      expect(store.getState().draftContent).toBe('{\n  "enabled": false,\n  "threshold": 0.9\n}\n');
      expectActionButtonSkeletons(container, false, false);
      expect(isDisabledNode(findButtonByText(container, zh.configs.formatButton))).toBeFalse();
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(findSaveButton(container)).not.toBeNull();

      const selectorTrigger: MiniDomNode | undefined = findElements(
        container,
        (node): boolean => hasClass(node, "config-selector-trigger")
      )[0];
      expect(selectorTrigger).toBeDefined();
      act((): void => {
        selectorTrigger?.triggerClick();
      });
      expect(store.getState().fileMenuOpen).toBeTrue();
      expect(
        findElements(
          selectorTrigger!,
          (node): boolean => hasClass(node, "chevron-icon") && hasClass(node, "rotated")
        )
      ).toHaveLength(1);

      const agentOption: MiniDomNode | null = findButtonByText(
        container,
        "agent.json"
      );
      expect(agentOption).not.toBeNull();
      act((): void => {
        agentOption?.triggerClick();
      });
      expect(useMiniAppStore.getState().confirmModal?.message).toBe(
        zh.configs.confirmDiscardChanges("ad_detect.json")
      );
      expect(useMiniAppStore.getState().confirmModal?.cancelLabel).toBeUndefined();
      expect(useMiniAppStore.getState().confirmModal?.confirmLabel).toBeUndefined();
      const discardConfirmActions: MiniDomNode | undefined = findElements(
        container,
        (node): boolean => hasClass(node, "confirm-actions")
      )[0];
      expect(discardConfirmActions).toBeDefined();
      const discardCancelBtn: MiniDomNode | null = findButtonByText(
        discardConfirmActions!,
        zh.confirmDialog.cancelButton
      );
      const discardAcceptBtn: MiniDomNode | null = findButtonByText(
        discardConfirmActions!,
        zh.confirmDialog.confirmButton
      );
      expect(discardCancelBtn).not.toBeNull();
      expect(discardAcceptBtn).not.toBeNull();
      expect(findButtonByText(discardConfirmActions!, "暂不执行")).toBeNull();
      expect(findButtonByText(discardConfirmActions!, "现在执行")).toBeNull();
      act((): void => {
        discardCancelBtn?.triggerClick();
      });
      await settle();
      expect(store.getState().selectedDynamicFile).toBe("ad_detect.json");

      act((): void => {
        jest.advanceTimersByTime(MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS + 10);
      });

      // 点击「保存」：在途期间按钮挂载 is-loading 且仅渲染三点波浪动效（不展示保存图标与任何文字），完成后恢复静态图标+文案。
      const saveBtn: MiniDomNode | null = findSaveButton(container);
      expect(saveBtn).not.toBeNull();
      expect(hasClass(saveBtn!, "is-loading")).toBeFalse();
      expect(saveBtn!.getAttribute("aria-busy")).toBe("false");
      expect(
        findElements(saveBtn!, (node): boolean => node.tagName.toUpperCase() === "SVG")
      ).toHaveLength(1);
      act((): void => {
        saveBtn?.triggerClick();
      });
      await act(async (): Promise<void> => {
        for (let i: number = 0; i < 6; i += 1) {
          Bun.sleepSync(2);
          await new Promise<void>((resolve: () => void): void => {
            setImmediate(resolve);
          });
        }
      });

      expect(store.getState().saving).toBeTrue();
      expect(findSaveButton(container)).toBeNull();
      expectInFlightDotsButton(container, "configs-save-btn");

      act((): void => {
        releasePendingSave?.();
      });
      await settle();

      expect(store.getState().saving).toBeFalse();
      expect(findElements(container, (node): boolean => hasClass(node, "configs-save-btn"))).toHaveLength(0);
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();

      expect(capturedOuterBody.length).toBeGreaterThan(0);
      expect(isMiniAppEncryptedEnvelope(JSON.parse(capturedOuterBody))).toBeTrue();
      expect(capturedOuterBody).not.toContain("threshold");
      expect(fetchLog.some((entry: string): boolean => entry.includes("/api/configs/write-key"))).toBeFalse();
      expect(capturedSaveReq).toEqual({
        scope: "dynamic",
        fileName: "ad_detect.json",
        content: '{\n  "enabled": false,\n  "threshold": 0.9\n}\n',
      });
      expect(useMiniAppStore.getState().confirmModal).toBeNull();
      expect(useMiniAppStore.getState().toastText).toBe(
        zh.serverNotice("CONFIG_SAVED", { fileName: "ad_detect.json" })
      );
      expect(findSaveButton(container)).toBeNull();

      // 保存后将同一 JSON 压缩为单行再点击「格式化」：点击播放三点动效，格式化结果与基准一致导致按钮被动消失时仍播放骨架。
      act((): void => {
        store.getState().setDraftContent('{"enabled":false,"threshold":0.9}');
      });
      advanceActionRevealWindow();
      act((): void => {
        findButtonByText(container, zh.configs.formatButton)?.triggerClick();
      });
      expectInFlightDotsButton(container, "configs-format-btn");
      await settle();
      expectActionButtonSkeletons(container, true, true);
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);

      // 切换到尚未创建的 mood.json：未修改时隐藏「还原修改」与「保存」，填入内容后同时显示两枚按钮，点击「还原修改」三点动效后直接退场。
      act((): void => {
        void store.getState().selectFile("mood.json");
      });
      await settle();
      expect(store.getState().fileExists).toBeFalse();
      expect(collectNodeText(container)).toContain(
        zh.configs.missingFileHint("mood.json")
      );
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();

      act((): void => {
        store.getState().setDraftContent('{\n  "default": "teasing"\n}\n');
      });
      expectActionButtonSkeletons(container, true, true);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(
        isDisabledNode(findSaveButton(container))
      ).toBeFalse();

      // 点击「还原修改」与点击「保存」一致：在途期间挂载 is-loading 仅渲染三点波浪动效（不播骨架、格式化与保存按钮禁用），完成后直接退场且再次编辑仍播放显现骨架。
      act((): void => {
        findButtonByText(container, zh.configs.resetButton)?.triggerClick();
      });
      expect(store.getState().resetting).toBeTrue();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(isDisabledNode(findButtonByText(container, zh.configs.formatButton))).toBeTrue();
      expect(isDisabledNode(findSaveButton(container))).toBeTrue();
      expectInFlightDotsButton(container, "configs-reset-btn");
      await settle();
      expect(store.getState().resetting).toBeFalse();
      expect(store.getState().draftContent).toBe("");
      expectActionButtonSkeletons(container, false, false);
      expect(findElements(container, (node): boolean => hasClass(node, "configs-reset-btn"))).toHaveLength(0);
      expect(findSaveButton(container)).toBeNull();

      // 还原后再次修改重新播放显现骨架；删改为空白仅隐藏「保存」并对其播放隐藏骨架，重新输入恢复显现，直接删空全部内容时两枚按钮同时播放隐藏骨架并最终消失。
      const expectMoodDraftTransition = (
        draft: string,
        resetSkeleton: boolean,
        saveSkeleton: boolean
      ): void => {
        act((): void => {
          store.getState().setDraftContent(draft);
        });
        expectActionButtonSkeletons(container, resetSkeleton, saveSkeleton);
      };

      expectMoodDraftTransition('{\n  "default": "playful"\n}\n', true, true);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(findSaveButton(container)).not.toBeNull();

      expectMoodDraftTransition("   ", false, true);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(findSaveButton(container)).toBeNull();

      expectMoodDraftTransition('{\n  "default": "calm"\n}\n', false, true);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findSaveButton(container)).not.toBeNull();

      expectMoodDraftTransition("", true, true);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
    });
  });

  test("前端语法错误、超体积拦截与服务端严格 Schema 校验失败均展开诊断横幅且不丢弃草稿", async () => {
    route("GET /api/configs", (): Response => jsonRes(buildCatalogFixture()));
    route("GET /api/configs/file", (): Response =>
      jsonRes({
        ok: true,
        scope: "dynamic",
        fileName: "ad_detect.json",
        exists: true,
        content: '{"enabled": true}\n',
      })
    );
    route("POST /api/configs/save", (): Response =>
      jsonRes(
        {
          ok: false,
          code: "CONFIG_VALIDATION_FAILED",
          error: "config/dynamic/ad_detect.json: unknown field 'badKey'",
        },
        400
      )
    );

    const store: MiniAppConfigsStore = createConfigsStore();
    await store.getState().loadInitialCatalogAndFile();

    // 0. 已有文件未产生实际修改时直接短路，不发任何请求。
    fetchLog.length = 0;
    await store.getState().saveCurrentConfig();
    expect(fetchLog).toEqual([]);

    // 1. 语法错误直接本地拦截，不发网络请求。
    store.getState().setDraftContent('{\n  "enabled": \n}');
    await store.getState().saveCurrentConfig();
    expect(fetchLog).toEqual([]);
    expect(store.getState().errorBanner).not.toBeNull();

    // 2. 体积超过 2 MiB 直接本地拦截。
    store
      .getState()
      .setDraftContent(`{"blob":"${"x".repeat(MINI_APP_MAX_CONFIG_CONTENT_BYTES + 32)}"}`);
    await store.getState().saveCurrentConfig();
    expect(fetchLog).toEqual([]);
    expect(store.getState().errorBanner).toBe(
      zh.configs.contentTooLargeError(MINI_APP_MAX_CONFIG_CONTENT_BYTES)
    );

    // 3. 合法 JSON 但未通过服务端严格字段校验时展示详细字段路径原因，且支持一键还原修改。
    const invalidSchemaDraft: string = '{"badKey": 123}\n';
    store.getState().setDraftContent(invalidSchemaDraft);
    await store.getState().saveCurrentConfig();
    expect(store.getState().errorBanner).toContain("badKey");
    expect(store.getState().draftContent).toBe(invalidSchemaDraft);

    await store.getState().resetDraft();
    expect(store.getState().draftContent).toBe('{"enabled": true}\n');
    expect(store.getState().errorBanner).toBeNull();
  });

  test("静态配置需实际修改才允许提交，保存成功后弹确认框执行 /api/configs/restart 并展示加载态与失败诊断", async () => {
    route("GET /api/configs", (): Response => jsonRes(buildCatalogFixture()));
    route("GET /api/configs/file", (url: URL): Response => {
      const scope: string = url.searchParams.get("scope") ?? "dynamic";
      const fileName: string = url.searchParams.get("fileName") ?? "ad_detect.json";
      return jsonRes({
        ok: true,
        scope,
        fileName,
        exists: true,
        content: '{"port": 8080}\n',
      });
    });
    route("POST /api/configs/save", (): Response =>
      jsonRes({
        ok: true,
        scope: "static",
        fileName: "bot.json",
        requiresRestart: true,
      })
    );

    let restartCallCount: number = 0;
    let releaseFirstRestart: (() => void) | null = null;
    route("POST /api/configs/restart", (): Response | Promise<Response> => {
      restartCallCount += 1;
      if (restartCallCount === 1) {
        return new Promise<Response>((resolve: (res: Response) => void): void => {
          releaseFirstRestart = (): void => {
            resolve(jsonRes({ ok: true }));
          };
        });
      }
      return jsonRes(
        {
          ok: false,
          code: "SERVICE_RESTART_FAILED",
          error: "Permission denied",
        },
        500
      );
    });

    const store: MiniAppConfigsStore = createConfigsStore();

    await withMountedConfigsPage(store, async (container, settle): Promise<void> => {
      await settle();

      const staticTabBtn: MiniDomNode | null = findButtonByText(
        container,
        zh.configs.staticTab
      );
      expect(staticTabBtn).not.toBeNull();
      act((): void => {
        staticTabBtn?.triggerClick();
      });
      await settle();

      expect(store.getState().scope).toBe("static");
      expect(store.getState().selectedStaticFile).toBe("bot.json");

      // 未修改时「还原修改」与「保存」均隐藏，调用 saveCurrentConfig 不会触发保存或重启确认。
      fetchLog.length = 0;
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
      await act(async (): Promise<void> => {
        await store.getState().saveCurrentConfig();
      });
      expect(fetchLog).toEqual([]);
      expect(useMiniAppStore.getState().confirmModal).toBeNull();

      // 第一次修改并保存，点击「暂不执行」取消重启确认：不调用 /api/configs/restart，且保存后因无新改动重新隐藏两枚按钮。
      act((): void => {
        store.getState().setDraftContent('{\n  "port": 9090\n}\n');
      });
      expectActionButtonSkeletons(container, true, true);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();
      advanceActionRevealWindow();
      expectActionButtonSkeletons(container, false, false);
      expect(findButtonByText(container, zh.configs.resetButton)).not.toBeNull();
      const firstSaveBtn: MiniDomNode | null = findSaveButton(container);
      expect(isDisabledNode(firstSaveBtn)).toBeFalse();
      act((): void => {
        firstSaveBtn?.triggerClick();
      });
      await settle();

      expect(useMiniAppStore.getState().confirmModal?.message).toBe(
        zh.configs.confirmRestartAfterSave("bot.json")
      );
      expect(useMiniAppStore.getState().confirmModal?.cancelLabel).toBe("暂不执行");
      expect(useMiniAppStore.getState().confirmModal?.confirmLabel).toBe("现在执行");
      const firstRestartActions: MiniDomNode | undefined = findElements(
        container,
        (node): boolean => hasClass(node, "confirm-actions")
      )[0];
      expect(firstRestartActions).toBeDefined();
      const firstCancelBtn: MiniDomNode | null = findButtonByText(firstRestartActions!, "暂不执行");
      const firstAcceptBtn: MiniDomNode | null = findButtonByText(firstRestartActions!, "现在执行");
      expect(firstCancelBtn).not.toBeNull();
      expect(firstAcceptBtn).not.toBeNull();
      expect(findButtonByText(firstRestartActions!, zh.confirmDialog.cancelButton)).toBeNull();
      expect(findButtonByText(firstRestartActions!, zh.confirmDialog.confirmButton)).toBeNull();
      act((): void => { firstCancelBtn?.triggerClick(); });
      await settle();
      expect(useMiniAppStore.getState().confirmModal).toBeNull();
      expect(
        findElements(container, (node): boolean => hasClass(node, "confirm-dialog"))
      ).toHaveLength(0);
      expect(restartCallCount).toBe(0);
      expect(findButtonByText(container, zh.configs.resetButton)).toBeNull();
      expect(findSaveButton(container)).toBeNull();

      // 第二次修改并保存，点击「现在执行」确认重启：在途期间保存按钮挂载 is-loading 仅展示三点波浪动效（无图标与文字），完成后提示成功。
      act((): void => {
        store.getState().setDraftContent('{\n  "port": 9091\n}\n');
      });
      advanceActionRevealWindow();
      act((): void => {
        findSaveButton(container)?.triggerClick();
      });
      await settle();

      expect(useMiniAppStore.getState().confirmModal?.message).toBe(
        zh.configs.confirmRestartAfterSave("bot.json")
      );
      const secondRestartActions: MiniDomNode | undefined = findElements(
        container,
        (node): boolean => hasClass(node, "confirm-actions")
      )[0];
      expect(secondRestartActions).toBeDefined();
      expect(findButtonByText(secondRestartActions!, "暂不执行")).not.toBeNull();
      const secondAcceptBtn: MiniDomNode | null = findButtonByText(
        secondRestartActions!,
        "现在执行"
      );
      expect(secondAcceptBtn).not.toBeNull();
      act((): void => {
        secondAcceptBtn?.triggerClick();
      });
      await act(async (): Promise<void> => {
        for (let i: number = 0; i < 20 && releaseFirstRestart === null; i += 1) {
          Bun.sleepSync(2);
          await new Promise<void>((r: () => void): void => { setImmediate(r); });
        }
      });

      expect(releaseFirstRestart).not.toBeNull();
      expect(store.getState().restarting).toBeTrue();
      expectActionButtonSkeletons(container, false, false);
      expect(findSaveButton(container)).toBeNull();
      expectInFlightDotsButton(container, "configs-save-btn");

      act((): void => {
        releaseFirstRestart?.();
      });
      await settle();

      expect(store.getState().restarting).toBeFalse();
      expect(restartCallCount).toBe(1);
      expect(useMiniAppStore.getState().toastText).toBe(
        zh.serverNotice("SERVICE_RESTARTED")
      );

      // 第三次修改并点击「现在执行」确认重启：若服务端重启返回失败，展开错误诊断横幅。
      act((): void => {
        store.getState().setDraftContent('{\n  "port": 9092\n}\n');
      });
      advanceActionRevealWindow();
      act((): void => {
        findSaveButton(container)?.triggerClick();
      });
      await settle();
      const thirdRestartActions: MiniDomNode | undefined = findElements(
        container,
        (node): boolean => hasClass(node, "confirm-actions")
      )[0];
      expect(thirdRestartActions).toBeDefined();
      act((): void => { findButtonByText(thirdRestartActions!, "现在执行")?.triggerClick(); });
      await settle();

      expect(restartCallCount).toBe(2);
      expect(store.getState().errorBanner).toContain("Permission denied");
    });
  });

  test("仅静态配置重启确认弹窗使用专属按钮文案，其余 requestConfirm 调用在三语言下保持默认按钮文案", async () => {
    const expectedRestartButtons: Readonly<
      Record<"zh" | "en" | "ja", readonly [string, string]>
    > = {
      zh: ["暂不执行", "现在执行"],
      en: ["Not Now", "Run Now"],
      ja: ["後で実行", "今すぐ実行"],
    };

    for (const lang of MINI_APP_LANGUAGES) {
      useMiniAppStore.getState().setLanguage(lang);
      const dict: Readonly<MiniAppTranslations> = getMiniAppTranslations(lang);
      const [expectedCancel, expectedAccept]: readonly [string, string] =
        expectedRestartButtons[lang];

      expect(dict.configs.restartConfirmCancelButton).toBe(expectedCancel);
      expect(dict.configs.restartConfirmAcceptButton).toBe(expectedAccept);

      // 1. 单参数与双参数 requestConfirm 默认回退至 t.confirmDialog.cancelButton / confirmButton。
      const oneArgConfirm: Promise<boolean> = useMiniAppStore
        .getState()
        .requestConfirm("default-1-arg");
      const oneArgHtml: string = renderToStaticMarkup(createElement(ConfirmModal));
      expect(oneArgHtml).toContain(`>${dict.confirmDialog.cancelButton}</button>`);
      expect(oneArgHtml).toContain(`>${dict.confirmDialog.confirmButton}</button>`);
      expect(oneArgHtml).not.toContain(`>${expectedCancel}</button>`);
      expect(oneArgHtml).not.toContain(`>${expectedAccept}</button>`);
      useMiniAppStore.getState().resolveConfirm(false);
      expect(await oneArgConfirm).toBeFalse();

      const twoArgConfirm: Promise<boolean> = useMiniAppStore
        .getState()
        .requestConfirm("default-2-arg", "primary");
      const twoArgHtml: string = renderToStaticMarkup(createElement(ConfirmModal));
      expect(twoArgHtml).toContain(`>${dict.confirmDialog.cancelButton}</button>`);
      expect(twoArgHtml).toContain(`>${dict.confirmDialog.confirmButton}</button>`);
      useMiniAppStore.getState().resolveConfirm(true);
      expect(await twoArgConfirm).toBeTrue();

      // 2. 传入自定义按钮文案时（如静态配置保存后的重启确认），按传入文案渲染。
      const customConfirm: Promise<boolean> = useMiniAppStore
        .getState()
        .requestConfirm(dict.configs.confirmRestartAfterSave("bot.json"), "primary", {
          cancelLabel: dict.configs.restartConfirmCancelButton,
          confirmLabel: dict.configs.restartConfirmAcceptButton,
        });
      const customHtml: string = renderToStaticMarkup(createElement(ConfirmModal));
      expect(customHtml).toContain(`aria-label="${expectedCancel}"`);
      expect(customHtml).toContain(`>${expectedCancel}</button>`);
      expect(customHtml).toContain(`>${expectedAccept}</button>`);
      expect(customHtml).not.toContain(`>${dict.confirmDialog.cancelButton}</button>`);
      expect(customHtml).not.toContain(`>${dict.confirmDialog.confirmButton}</button>`);
      useMiniAppStore.getState().resolveConfirm(false);
      expect(await customConfirm).toBeFalse();
    }
  });
});
