/**
 * Mini App 配置文件下拉选择器（`ConfigFileSelector`）单元测试：
 * - 校验触发头对齐实时状态子系统能力折叠面板（左侧状态方点、等宽文件名、序号/未保存胶囊与说明，右侧状态徽章与折角翻转箭头胶囊），无顶部色带高亮；
 * - 校验展开列表收缩为单屏 `MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS` 项高度，底部色带锚定，动态配置（超出单屏上限）挂载纵向高度滑条而静态配置（未超出上限）省略滑条；
 * - 校验展开时自动将当前选中项滚入可视窗口、列表滚动实时同步滑块百分比，以及点击轨道跳转、按住滑块拖拽与禁用/退场保护分支；
 * - 校验 JSON 编辑器（`JsonCodeEditor`）的新粗野主义纵横平行四边形滑条（亮/暗双主题高对比亮黄滑块、隐藏原生滚动条、实心通道底色与右下角互让间距，以及纵横点击/拖拽交互）。
 */

import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  computeConfigSelectorThumbMetrics,
  ConfigFileSelector,
} from "../../packages/mini-app-frontend/components/ConfigFileSelector";
import type { ConfigFileSelectorProps } from "../../packages/mini-app-frontend/components/ConfigFileSelector";
import {
  computeJsonEditorScrollbarThumbMetrics,
  JsonCodeEditor,
} from "../../packages/mini-app-frontend/components/JsonCodeEditor";
import { MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS } from "../../packages/mini-app-frontend/consts/miniApp";
import {
  MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT,
  MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS,
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_JSON_EDITOR_CORNER_CLEARANCE_PX,
  MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT,
  MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../../packages/mini-app-frontend/consts/miniAppConfig";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import type { MiniAppConfigFileItem } from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";

const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function buildDynamicItems(): readonly Readonly<MiniAppConfigFileItem>[] {
  return MINI_APP_DYNAMIC_CONFIG_FILES.map(
    (fileName, idx): Readonly<MiniAppConfigFileItem> => ({
      scope: "dynamic",
      fileName,
      exists: idx !== 4,
    })
  );
}

function buildStaticItems(): readonly Readonly<MiniAppConfigFileItem>[] {
  return MINI_APP_STATIC_CONFIG_FILES.map(
    (fileName): Readonly<MiniAppConfigFileItem> => ({
      scope: "static",
      fileName,
      exists: true,
    })
  );
}

/** 从 React 纤维属性桶中提取绑定的合成事件处理器。 */
function getReactPropHandler(
  node: MiniDomNode,
  propName: string
): ((event: Record<string, unknown>) => void) | undefined {
  const record: Record<string, unknown> = node as unknown as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(record)) {
    if (key.startsWith("__reactProps$")) {
      const propsObj: Record<string, unknown> | undefined = record[key] as
        | Record<string, unknown>
        | undefined;
      const handler: unknown = propsObj?.[propName];
      if (typeof handler === "function") {
        return handler as (event: Record<string, unknown>) => void;
      }
    }
  }
  return undefined;
}

afterEach((): void => {
  jest.useRealTimers();
});

describe("ConfigFileSelector 样式结构、三项限高与纵向高度滑条", () => {
  test("computeConfigSelectorThumbMetrics 覆盖真实滚动度量、最小滑块下限与无布局引擎回退比例", () => {
    // 1. 真实滚动几何：可视 196px / 总高 392px -> 滑块高 50%，滚至中点 -> top 25%，滚到底 -> top 50%。
    expect(
      computeConfigSelectorThumbMetrics({
        scrollTop: 0,
        scrollHeight: 392,
        clientHeight: 196,
        itemCount: MINI_APP_DYNAMIC_CONFIG_FILES.length,
      })
    ).toEqual({ heightPercent: 50, topPercent: 0 });
    expect(
      computeConfigSelectorThumbMetrics({
        scrollTop: 98,
        scrollHeight: 392,
        clientHeight: 196,
        itemCount: MINI_APP_DYNAMIC_CONFIG_FILES.length,
      })
    ).toEqual({ heightPercent: 50, topPercent: 25 });
    expect(
      computeConfigSelectorThumbMetrics({
        scrollTop: 999,
        scrollHeight: 392,
        clientHeight: 196,
        itemCount: MINI_APP_DYNAMIC_CONFIG_FILES.length,
      })
    ).toEqual({ heightPercent: 50, topPercent: 50 });

    // 2. 超长内容触发最小滑块高度百分比下限保护。
    const clampedMetrics = computeConfigSelectorThumbMetrics({
      scrollTop: 1_000,
      scrollHeight: 2_000,
      clientHeight: 100,
      itemCount: 30,
    });
    expect(clampedMetrics.heightPercent).toBe(
      MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT
    );
    expect(clampedMetrics.topPercent).toBeCloseTo(
      (1_000 / 1_900) * (100 - MINI_APP_CONFIG_SELECTOR_MIN_THUMB_PERCENT),
      5
    );

    // 3. 无布局引擎度量（clientHeight = 0）时按 MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS / itemCount 回退。
    const dynamicCount: number = MINI_APP_DYNAMIC_CONFIG_FILES.length;
    expect(
      computeConfigSelectorThumbMetrics({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        itemCount: dynamicCount,
      })
    ).toEqual({
      heightPercent:
        (MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS / dynamicCount) * 100,
      topPercent: 0,
    });

    // 4. 项数不超过单屏可见上限时返回 100% 高度、0 偏移。
    expect(
      computeConfigSelectorThumbMetrics({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        itemCount: MINI_APP_STATIC_CONFIG_FILES.length,
      })
    ).toEqual({ heightPercent: 100, topPercent: 0 });
  });

  test("触发头复用子系统能力折叠头视觉元素（状态方点、序号/未保存胶囊、右侧徽章与翻转箭头胶囊），动态配置带滑条而静态配置不挂载滑条", async () => {
    const environment: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      const dynamicItems: readonly Readonly<MiniAppConfigFileItem>[] =
        buildDynamicItems();
      const staticItems: readonly Readonly<MiniAppConfigFileItem>[] =
        buildStaticItems();

      const baseProps: ConfigFileSelectorProps = {
        scope: "dynamic",
        items: dynamicItems,
        selectedFile: "agent.json",
        fileExists: true,
        isDirty: false,
        menuOpen: false,
        disabled: false,
        t: zh,
        onToggleMenu: (): void => undefined,
        onCloseMenu: (): void => undefined,
        onSelectFile: (): void => undefined,
      };

      try {
        await act(async (): Promise<void> => {
          root.render(createElement(ConfigFileSelector, baseProps));
        });

        // 收起态：无旧版 toolbar-icon-badge，展示绿色状态方点、02/06 序号胶囊、右侧就绪徽章与未展开箭头胶囊。
        expect(
          findElements(container, (n): boolean =>
            hasClass(n, "toolbar-icon-badge")
          )
        ).toHaveLength(0);
        const dotNodes: MiniDomNode[] = findElements(container, (n): boolean =>
          hasClass(n, "config-selector-status-dot")
        );
        expect(dotNodes).toHaveLength(1);
        expect(hasClass(dotNodes[0]!, "ok")).toBeTrue();

        const summaryPill: MiniDomNode | undefined = findElements(
          container,
          (n): boolean => hasClass(n, "config-selector-summary-pill")
        )[0];
        expect(summaryPill).toBeDefined();
        expect(hasClass(summaryPill!, "is-dirty")).toBeFalse();
        expect(collectNodeText(summaryPill!)).toBe(
          `02/${dynamicItems.length.toString().padStart(2, "0")}`
        );

        const chevronPill: MiniDomNode | undefined = findElements(
          container,
          (n): boolean => hasClass(n, "config-selector-chevron-pill")
        )[0];
        expect(chevronPill).toBeDefined();
        expect(hasClass(chevronPill!, "open")).toBeFalse();

        // 脏草稿 + 缺失文件 + 展开态：方点切 warn，胶囊切换为 is-dirty 未保存文案，箭头胶囊点亮 open，且动态配置挂载高度滑条。
        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigFileSelector, {
              ...baseProps,
              selectedFile: "mood.json",
              fileExists: false,
              isDirty: true,
              menuOpen: true,
            })
          );
        });

        expect(hasClass(dotNodes[0]!, "warn")).toBeTrue();
        expect(hasClass(summaryPill!, "is-dirty")).toBeTrue();
        expect(collectNodeText(summaryPill!)).toBe(zh.configs.dirtyBadge);
        expect(hasClass(chevronPill!, "open")).toBeTrue();
        expect(
          findElements(container, (n): boolean =>
            hasClass(n, "config-selector-scrollbar")
          )
        ).toHaveLength(1);
        expect(
          findElements(container, (n): boolean =>
            hasClass(n, "config-selector-scrollbar-thumb")
          )
        ).toHaveLength(1);

        // 切至静态配置（仅 2 个文件，不超过单屏 3 项上限）：不渲染高度滑条。
        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigFileSelector, {
              ...baseProps,
              scope: "static",
              items: staticItems,
              selectedFile: "bot.json",
              menuOpen: true,
            })
          );
        });
        expect(staticItems.length).toBeLessThanOrEqual(
          MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS
        );
        expect(
          findElements(container, (n): boolean =>
            hasClass(n, "config-selector-scrollbar")
          )
        ).toHaveLength(0);
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
    } finally {
      environment.restore();
    }
  });

  test("展开时自动将选中项滚入三项可视窗，滚动列表与点击/拖拽纵向滑条双向同步位置，退场与禁用态忽略滑条指针输入", async () => {
    jest.useFakeTimers();
    const environment: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      const dynamicItems: readonly Readonly<MiniAppConfigFileItem>[] =
        buildDynamicItems();

      let closeCount: number = 0;
      const renderSelector = async (
        overrides: Partial<ConfigFileSelectorProps>
      ): Promise<void> => {
        await act(async (): Promise<void> => {
          root.render(
            createElement(ConfigFileSelector, {
              scope: "dynamic",
              items: dynamicItems,
              selectedFile: "stickers.json",
              fileExists: true,
              isDirty: false,
              menuOpen: false,
              disabled: false,
              t: zh,
              onToggleMenu: (): void => undefined,
              onCloseMenu: (): void => {
                closeCount += 1;
              },
              onSelectFile: (): void => undefined,
              ...overrides,
            })
          );
        });
      };

      try {
        await renderSelector({ menuOpen: false });
        await renderSelector({ menuOpen: true, selectedFile: "stickers.json" });

        const listNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "config-selector-list")
        )[0]!;
        const trackNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "config-selector-scrollbar")
        )[0]!;
        const thumbNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "config-selector-scrollbar-thumb")
        )[0]!;

        // 注入真实盒模型尺寸（6 项总高 392px，3 项可视窗 196px；每项高 59px、间距 7px）。
        const listMetrics: Record<string, unknown> =
          listNode as unknown as Record<string, unknown>;
        listMetrics.clientHeight = 196;
        listMetrics.scrollHeight = 392;
        for (let i: number = 0; i < listNode.childNodes.length; i += 1) {
          const childRecord: Record<string, unknown> = listNode
            .childNodes[i]! as unknown as Record<string, unknown>;
          childRecord.offsetTop = i * 66;
          childRecord.offsetHeight = 59;
        }

        const capturedPointers: number[] = [];
        const releasedPointers: number[] = [];
        const draggingTokens: Set<string> = new Set<string>();
        const trackRecord: Record<string, unknown> =
          trackNode as unknown as Record<string, unknown>;
        trackRecord.getBoundingClientRect = (): { top: number; height: number } => ({
          top: 100,
          height: 192,
        });
        trackRecord.setPointerCapture = (id: number): void => {
          capturedPointers.push(id);
        };
        trackRecord.releasePointerCapture = (id: number): void => {
          releasedPointers.push(id);
        };

        let mockThumbRect: { top: number; height: number } = {
          top: 100,
          height: 96,
        };
        const thumbRecord: Record<string, unknown> =
          thumbNode as unknown as Record<string, unknown>;
        thumbRecord.getBoundingClientRect = (): { top: number; height: number } =>
          mockThumbRect;
        thumbRecord.classList = {
          add: (token: string): void => {
            draggingTokens.add(token);
          },
          remove: (token: string): void => {
            draggingTokens.delete(token);
          },
        };

        // 1. 触发列表滚动事件：滑块高 50%，滚至底端时 top 同步为 50.00%，且属性更新重渲染不会重置滑块偏移。
        listNode.scrollTop = 196;
        const onScroll = getReactPropHandler(listNode, "onScroll");
        expect(onScroll).toBeDefined();
        act((): void => {
          onScroll?.({});
        });
        expect(thumbNode.style.height).toBe("50.00%");
        expect(thumbNode.style.top).toBe("50.00%");

        await renderSelector({
          menuOpen: true,
          selectedFile: "stickers.json",
          isDirty: true,
        });
        expect(thumbNode.style.top).toBe("50.00%");

        // 2. 点击滑轨下半区（clientY = 260，落在滑块 [100, 196] 之外）：立即跳转 scrollTop 并捕获指针。
        listNode.scrollTop = 0;
        mockThumbRect = { top: 100, height: 96 };
        const onPointerDown = getReactPropHandler(trackNode, "onPointerDown");
        const onPointerMove = getReactPropHandler(trackNode, "onPointerMove");
        const onPointerUp = getReactPropHandler(trackNode, "onPointerUp");
        const onPointerCancel = getReactPropHandler(
          trackNode,
          "onPointerCancel"
        );
        expect(onPointerDown).toBeDefined();
        expect(onPointerMove).toBeDefined();
        expect(onPointerUp).toBeDefined();
        expect(onPointerCancel).toBeDefined();

        act((): void => {
          onPointerDown?.({
            pointerId: 7,
            clientY: 260,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
        });
        expect(capturedPointers).toEqual([7]);
        expect(draggingTokens.has("dragging")).toBeTrue();
        expect(listNode.scrollTop).toBeGreaterThan(150);

        // 非激活 pointerId 的移动与抬起均被忽略。
        const prevScrollAfterJump: number = listNode.scrollTop;
        act((): void => {
          onPointerMove?.({
            pointerId: 99,
            clientY: 100,
            preventDefault: (): void => undefined,
          });
          onPointerUp?.({ pointerId: 99 });
        });
        expect(listNode.scrollTop).toBe(prevScrollAfterJump);
        expect(draggingTokens.has("dragging")).toBeTrue();

        // 拖拽至轨道顶部并释放指针：scrollTop 回到 0，移除 dragging 类并释放捕获。
        act((): void => {
          onPointerMove?.({
            pointerId: 7,
            clientY: 100,
            preventDefault: (): void => undefined,
          });
          onPointerUp?.({ pointerId: 7 });
        });
        expect(listNode.scrollTop).toBe(0);
        expect(thumbNode.style.top).toBe("0.00%");
        expect(draggingTokens.has("dragging")).toBeFalse();
        expect(releasedPointers).toEqual([7]);

        // 3. 直接按住滑块内部（clientY = 120 位于 [100, 196] 内）：初始按下不跳变，移动 48px 后按精确抓取偏移推进一半行程。
        act((): void => {
          onPointerDown?.({
            pointerId: 8,
            clientY: 120,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
        });
        expect(listNode.scrollTop).toBe(0);
        act((): void => {
          onPointerMove?.({
            pointerId: 8,
            clientY: 168,
            preventDefault: (): void => undefined,
          });
          onPointerCancel?.({ pointerId: 8 });
        });
        expect(listNode.scrollTop).toBe(98);
        expect(thumbNode.style.top).toBe("25.00%");
        expect(draggingTokens.has("dragging")).toBeFalse();

        // 4. 收起后再以末尾项重新展开（模拟列表已挂载）：自动调整 scrollTop 使选中项落入可视窗口。
        await renderSelector({ menuOpen: false });
        // 退场期间点击遮罩与按下滑条均被忽略。
        const backdropNode: MiniDomNode = findElements(
          container,
          (n): boolean => hasClass(n, "config-selector-backdrop")
        )[0]!;
        act((): void => {
          backdropNode.triggerClick();
          getReactPropHandler(trackNode, "onPointerDown")?.({
            pointerId: 12,
            clientY: 250,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
        });
        expect(closeCount).toBe(0);
        expect(capturedPointers).toEqual([7, 8]);

        // 在退场尚未卸载前重新打开：从顶部自动滚至第 6 项（offsetTop = 330, height = 59 -> 389 - 196 = 193），再测上方越界分支。
        listNode.scrollTop = 0;
        await renderSelector({ menuOpen: true, selectedFile: "stickers.json" });
        expect(listNode.scrollTop).toBe(330 + 59 - 196);

        await renderSelector({ menuOpen: false });
        listNode.scrollTop = 180;
        await renderSelector({ menuOpen: true, selectedFile: "ad_detect.json" });
        expect(listNode.scrollTop).toBe(0);

        // 禁用态下按下滑条不捕获指针；若拖拽中途切入禁用态则立即清理 dragging 类并忽略后续移动；非退场态点击遮罩正常触发关闭回调。
        act((): void => {
          getReactPropHandler(trackNode, "onPointerDown")?.({
            pointerId: 14,
            clientY: 120,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
        });
        expect(draggingTokens.has("dragging")).toBeTrue();
        await renderSelector({
          menuOpen: true,
          disabled: true,
          selectedFile: "ad_detect.json",
        });
        expect(draggingTokens.has("dragging")).toBeFalse();
        act((): void => {
          getReactPropHandler(trackNode, "onPointerMove")?.({
            pointerId: 14,
            clientY: 260,
            preventDefault: (): void => undefined,
          });
          getReactPropHandler(trackNode, "onPointerDown")?.({
            pointerId: 15,
            clientY: 240,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
          backdropNode.triggerClick();
        });
        expect(listNode.scrollTop).toBe(0);
        expect(capturedPointers).toEqual([7, 8, 14]);
        expect(closeCount).toBe(1);

        // 推进定时器完成延迟卸载。
        await renderSelector({ menuOpen: false });
        act((): void => {
          jest.advanceTimersByTime(MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS + 10);
        });
        expect(
          findElements(container, (n): boolean =>
            hasClass(n, "config-selector-popover")
          )
        ).toHaveLength(0);
      } finally {
        await act(async (): Promise<void> => {
          root.unmount();
        });
      }
    } finally {
      environment.restore();
    }
  });

  test("JsonCodeEditor 纵横平行四边形滑条：内容溢出时按轴向显隐实心底色槽与右下角互让间距，并支持点击轨道跳转与按住滑块拖拽", async () => {
    expect(
      computeJsonEditorScrollbarThumbMetrics({
        scrollOffset: 0,
        scrollSize: 300,
        clientSize: 300,
      })
    ).toEqual({ overflow: false, sizePercent: 100, offsetPercent: 0 });
    expect(
      computeJsonEditorScrollbarThumbMetrics({
        scrollOffset: 200,
        scrollSize: 800,
        clientSize: 400,
      })
    ).toEqual({ overflow: true, sizePercent: 50, offsetPercent: 25 });
    expect(
      computeJsonEditorScrollbarThumbMetrics({
        scrollOffset: 0,
        scrollSize: 4_000,
        clientSize: 200,
      }).sizePercent
    ).toBe(MINI_APP_JSON_EDITOR_MIN_THUMB_PERCENT);

    const environment: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = environment.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);

      try {
        await act(async (): Promise<void> => {
          root.render(
            createElement(JsonCodeEditor, {
              fileName: "agent.json",
              value: '{\n  "ok": true\n}\n',
              fileExists: true,
              disabled: false,
              t: zh,
              onChange: (): void => undefined,
            })
          );
        });

        const canvasNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-canvas")
        )[0]!;
        const gutterNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-gutter")
        )[0]!;
        const textareaNode: MiniDomNode = findElements(
          container,
          (n): boolean => hasClass(n, "json-editor-textarea")
        )[0]!;
        const vLaneNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scroll-lane-v")
        )[0]!;
        const hLaneNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scroll-lane-h")
        )[0]!;
        const vTrackNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scrollbar-v")
        )[0]!;
        const vThumbNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scrollbar-thumb-v")
        )[0]!;
        const hTrackNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scrollbar-h")
        )[0]!;
        const hThumbNode: MiniDomNode = findElements(container, (n): boolean =>
          hasClass(n, "json-editor-scrollbar-thumb-h")
        )[0]!;

        // 初始无溢出：纵横滑条底色槽均隐藏，画布占满 0px 边距。
        expect(vLaneNode.style.display).toBe("none");
        expect(hLaneNode.style.display).toBe("none");
        expect(canvasNode.style.right).toBe("0px");
        expect(canvasNode.style.bottom).toBe("0px");

        // 模拟隐藏原生滚动条（offset === client）且纵横内容同时溢出：双轴平行四边形滑条同时显示并在右下角互让。
        const taRecord: Record<string, unknown> =
          textareaNode as unknown as Record<string, unknown>;
        taRecord.offsetWidth = 340;
        taRecord.clientWidth = 340;
        taRecord.scrollWidth = 680;
        taRecord.offsetHeight = 300;
        taRecord.clientHeight = 300;
        taRecord.scrollHeight = 600;
        taRecord.scrollLeft = 0;
        textareaNode.scrollTop = 0;

        (
          vTrackNode as unknown as Record<string, unknown>
        ).getBoundingClientRect = (): {
          left: number;
          top: number;
          width: number;
          height: number;
        } => ({ left: 320, top: 50, width: 11, height: 200 });
        (
          vThumbNode as unknown as Record<string, unknown>
        ).getBoundingClientRect = (): {
          left: number;
          top: number;
          width: number;
          height: number;
        } => ({ left: 320, top: 50, width: 11, height: 100 });
        (
          hTrackNode as unknown as Record<string, unknown>
        ).getBoundingClientRect = (): {
          left: number;
          top: number;
          width: number;
          height: number;
        } => ({ left: 50, top: 280, width: 240, height: 11 });
        (
          hThumbNode as unknown as Record<string, unknown>
        ).getBoundingClientRect = (): {
          left: number;
          top: number;
          width: number;
          height: number;
        } => ({ left: 50, top: 280, width: 120, height: 11 });

        const onScroll = getReactPropHandler(textareaNode, "onScroll");
        act((): void => {
          onScroll?.({});
        });

        expect(vLaneNode.style.display).toBe("block");
        expect(hLaneNode.style.display).toBe("block");
        expect(canvasNode.style.right).toBe(
          `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        );
        expect(canvasNode.style.bottom).toBe(
          `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        );
        expect(gutterNode.style.bottom).toBe(
          `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        );
        expect(vTrackNode.style.bottom).toBe(
          `${MINI_APP_JSON_EDITOR_CORNER_CLEARANCE_PX}px`
        );
        expect(hLaneNode.style.right).toBe(
          `${MINI_APP_JSON_EDITOR_SCROLLBAR_LANE_PX}px`
        );

        // 纵向轨道点击跳转与拖拽。
        act((): void => {
          getReactPropHandler(vTrackNode, "onPointerDown")?.({
            pointerId: 1,
            clientX: 325,
            clientY: 200,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
          getReactPropHandler(vTrackNode, "onPointerMove")?.({
            pointerId: 1,
            clientX: 325,
            clientY: 250,
            preventDefault: (): void => undefined,
          });
          getReactPropHandler(vTrackNode, "onPointerUp")?.({
            pointerId: 1,
          });
        });
        expect(textareaNode.scrollTop).toBe(300);
        expect(vThumbNode.style.top).toBe("50.00%");

        // 横向滑块直接按住抓取并向右拖拽一半行程（grabOffset = 80 - 50 = 30，移动至 clientX = 140 -> 偏移 60 / 120 = 50%）。
        act((): void => {
          getReactPropHandler(hTrackNode, "onPointerDown")?.({
            pointerId: 2,
            clientX: 80,
            clientY: 285,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
          getReactPropHandler(hTrackNode, "onPointerMove")?.({
            pointerId: 2,
            clientX: 140,
            clientY: 285,
            preventDefault: (): void => undefined,
          });
          getReactPropHandler(hTrackNode, "onPointerCancel")?.({
            pointerId: 2,
          });
        });
        expect(taRecord.scrollLeft).toBe(170);
        expect(hThumbNode.style.left).toBe("25.00%");

        // 拖拽中途进入禁用态（如保存提交中）：自动清理滑块 dragging 类并阻断后续移动。
        const vDraggingTokens: Set<string> = new Set<string>();
        (vThumbNode as unknown as Record<string, unknown>).classList = {
          add: (token: string): void => {
            vDraggingTokens.add(token);
          },
          remove: (token: string): void => {
            vDraggingTokens.delete(token);
          },
        };
        act((): void => {
          getReactPropHandler(vTrackNode, "onPointerDown")?.({
            pointerId: 3,
            clientX: 325,
            clientY: 80,
            preventDefault: (): void => undefined,
            stopPropagation: (): void => undefined,
          });
        });
        expect(vDraggingTokens.has("dragging")).toBeTrue();
        await act(async (): Promise<void> => {
          root.render(
            createElement(JsonCodeEditor, {
              fileName: "agent.json",
              value: '{\n  "ok": true\n}\n',
              fileExists: true,
              disabled: true,
              t: zh,
              onChange: (): void => undefined,
            })
          );
        });
        expect(vDraggingTokens.has("dragging")).toBeFalse();
        act((): void => {
          getReactPropHandler(vTrackNode, "onPointerMove")?.({
            pointerId: 3,
            clientX: 325,
            clientY: 50,
            preventDefault: (): void => undefined,
          });
        });
        expect(textareaNode.scrollTop).toBe(300);
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
