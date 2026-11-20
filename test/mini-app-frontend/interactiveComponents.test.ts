/**
 * Mini App 前端图库、分页、受管群菜单与能力卡片组件真实挂载 DOM 事件测试：
 * 覆盖 `GalleryGridList`、`GalleryPreviewCard`、`PaginationBar`、`ChatTargetsMenuButtonList`
 * 与 `CapabilityBlock` 的真实挂载与交互事件处理器。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { CapabilityBlock } from "../../packages/mini-app-frontend/components/CapabilityBlock";
import { ChatTargetsMenuButtonList } from "../../packages/mini-app-frontend/components/ChatTargetsMenuButtonList";
import { GalleryGridList } from "../../packages/mini-app-frontend/components/GalleryGridList";
import { GalleryPreviewCard } from "../../packages/mini-app-frontend/components/GalleryPreviewCard";
import { PaginationBar } from "../../packages/mini-app-frontend/components/PaginationBar";
import type { ViewportAnchorScroll } from "../../packages/mini-app-frontend/components/animations/expandFollowScroll";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
  MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
  MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS,
  MINI_APP_PAGINATION_HOVER_DURATION_MS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { resetMiniAppStoreForTest } from "../../packages/mini-app-frontend/store/app";
import type {
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppChatTargetKind,
  MiniAppChatTargetsView,
  MiniAppGalleryItem,
} from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import {
  collectNodeText,
  findElements,
  hasClass,
  installMiniDom,
} from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import { seedTestMiniAppSession, wrapEncryptedTestFetch } from "./helpers/encryptedFetchMock";

const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");
const originalFetch: typeof fetch = globalThis.fetch;

/** 从 React 纤维属性桶提取挂在 DOM 节点上的合成事件回调。 */
function getReactPropHandler(
  node: MiniDomNode,
  propName: string
): ((event: Record<string, unknown>) => void) | undefined {
  const record: Record<string, unknown> = node as unknown as Record<string, unknown>;
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

/** 构造群详情夹具。 */
function sampleChatDetail(overrides: Partial<MiniAppChatDetail> = {}): Readonly<MiniAppChatDetail> {
  return {
    chatId: -1001,
    title: "互动测试群",
    isLockdownActive: false,
    quietRemainingMs: 0,
    lockdownRemainingMs: 0,
    activeSessions: { gag: 0, wed: false, verify: 0, qaSet: false },
    hotMessageCount: 5,
    hotMessageMax: VERBATIM_CONTEXT_MAX,
    qaPairCount: 2,
    deleteMessageTargetCount: 1,
    translateTargetCount: 1,
    joinedCountsByHour: Array.from(
      { length: MINI_APP_BATCH_KICK_MAX_HOURS },
      (_: unknown, idx: number): number => idx + 1
    ),
    batchKickRunning: false,
    lastBatchKickCompletion: null,
    features: {
      init: true,
      aiChat: true,
      translation: true,
      adDetect: false,
      floodControl: false,
      antiRaid: false,
      proxySend: false,
    },
    botPermissions: {
      canDeleteMessages: true,
      canRestrictMembers: true,
      canChangeInfo: false,
      grantedLabels: ["canDeleteMessages"],
    },
    ...overrides,
  };
}

/** 在受管最小 DOM 环境下挂载并在结束后卸载 React 根容器。 */
async function withMountedDom(
  run: (ctx: { readonly env: MiniDomEnvironment; readonly container: MiniDomNode; readonly root: Root }) => Promise<void> | void
): Promise<void> {
  const env: MiniDomEnvironment = installMiniDom();
  const container: MiniDomNode = env.document.createElement("div");
  const root: Root = createRoot(container as unknown as Element);
  try {
    await run({ env, container, root });
  } finally {
    await act(async (): Promise<void> => {
      root.unmount();
    });
    env.restore();
  }
}

beforeEach((): void => {
  resetMiniAppStoreForTest();
  seedTestMiniAppSession("f".repeat(64), Date.now() + 600_000);
  globalThis.fetch = wrapEncryptedTestFetch((): Response => Response.json({ ok: true }));
});

afterEach((): void => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearMiniAppSessionToken();
  resetMiniAppStoreForTest();
});

describe("Mini App 前端图库、分页、受管群菜单与能力卡片组件真实挂载 DOM 事件测试", () => {
  test("GalleryGridList 与 GalleryPreviewCard 覆盖点击、悬停抑制/释放、缓存完成态探测及 onLoad/onError", async () => {
    const items: readonly Readonly<MiniAppGalleryItem>[] = [
      {
        fileName: "1".repeat(64) + ".png",
        mimeType: "image/png",
        sizeBytes: 2048,
        updatedAt: "2026-05-01 10:00:00",
      },
      {
        fileName: "2".repeat(64) + ".webp",
        mimeType: "image/webp",
        sizeBytes: 4096,
        updatedAt: "2026-05-01 11:00:00",
      },
    ];
    const selected: string[] = [];
    const downloaded: string[] = [];
    const deleted: string[] = [];
    const loadedCalls: { readonly fileName: string; readonly epoch: number }[] = [];

    await withMountedDom(async ({ env, container, root }): Promise<void> => {
      // 使 <img> 节点将 setAttribute("src", ...) 同步到 .src 且暴露 complete=true 以测试缓存完成态探测。
      const origCreateElement = env.document.createElement.bind(env.document);
      let imgCompleteFlag: boolean = true;
      env.document.createElement = (tag: string): MiniDomNode => {
        const node: MiniDomNode = origCreateElement(tag);
        if (tag.toLowerCase() === "img") {
          const origSetAttr = node.setAttribute.bind(node);
          node.setAttribute = (name: string, val: string): void => {
            origSetAttr(name, val);
            if (name === "src") {
              (node as unknown as { src?: string }).src = val;
            }
          };
          Object.defineProperty(node, "complete", {
            configurable: true,
            get: (): boolean => imgCompleteFlag,
          });
        }
        return node;
      };

      const renderGrid = async (
        busyDownload: string | null = null,
        busyDelete: string | null = null
      ): Promise<void> => {
        await act(async (): Promise<void> => {
          root.render(
            createElement(GalleryGridList, {
              items,
              imageObjectUrls: {
                [items[0]!.fileName]: "blob:https://mini.test/img-1",
                [items[1]!.fileName]: "blob:https://mini.test/img-2",
              },
              previewItem: items[0]!,
              deletingFileName: busyDelete,
              downloadingFileName: busyDownload,
              loadedImages: {},
              batchEpoch: 7,
              t: zh,
              onMarkThumbLoaded: (fileName: string, epoch: number): void => {
                loadedCalls.push({ fileName, epoch });
              },
              onSelectPreviewItem: (item: Readonly<MiniAppGalleryItem>): void => {
                selected.push(item.fileName);
              },
              onDownloadImage: (fileName: string): void => {
                downloaded.push(fileName);
              },
              onDeleteImage: (fileName: string): void => {
                deleted.push(fileName);
              },
            })
          );
        });
      };

      await renderGrid();
      // 首次挂载时 img ref 命中 complete=true 自动回调 onMarkThumbLoaded。
      expect(loadedCalls).toEqual([
        { fileName: items[0]!.fileName, epoch: 7 },
        { fileName: items[1]!.fileName, epoch: 7 },
      ]);

      // 手动触发 img onLoad 与 onError。
      const imgs: MiniDomNode[] = findElements(container, (el): boolean => el.tagName === "IMG");
      expect(imgs).toHaveLength(2);
      await act(async (): Promise<void> => {
        getReactPropHandler(imgs[0]!, "onLoad")?.({});
        getReactPropHandler(imgs[1]!, "onError")?.({});
      });
      expect(loadedCalls).toHaveLength(4);

      // 点击卡片选中预览。
      const cards: MiniDomNode[] = findElements(container, (el): boolean => hasClass(el, "gallery-card"));
      await act(async (): Promise<void> => {
        cards[1]!.triggerClick();
      });
      expect(selected).toEqual([items[1]!.fileName]);

      // 点击下载按钮（阻止冒泡不触发选中预览）-> 激活 hover-suppressed -> 细微移动保持抑制 -> 大幅移动解除抑制。
      const dlBtns: MiniDomNode[] = findElements(
        container,
        (el): boolean => hasClass(el, "gallery-card-download-btn")
      );
      const delBtns: MiniDomNode[] = findElements(
        container,
        (el): boolean => hasClass(el, "gallery-card-delete-btn")
      );
      let blurred: number = 0;
      await act(async (): Promise<void> => {
        getReactPropHandler(dlBtns[0]!, "onClick")?.({
          clientX: 100,
          clientY: 200,
          stopPropagation: (): void => {},
          currentTarget: { blur: (): void => { blurred += 1; } },
        });
      });
      expect(downloaded).toEqual([items[0]!.fileName]);
      expect(blurred).toBe(1);
      expect(hasClass(dlBtns[0]!, "hover-suppressed")).toBeTrue();

      // 移动距离未超过阈值，仍保持抑制。
      await act(async (): Promise<void> => {
        getReactPropHandler(dlBtns[0]!, "onMouseMove")?.({
          clientX: 100 + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX,
          clientY: 200,
        });
      });
      expect(hasClass(dlBtns[0]!, "hover-suppressed")).toBeTrue();

      // 移动距离超过阈值，解除抑制。
      await act(async (): Promise<void> => {
        getReactPropHandler(dlBtns[0]!, "onMouseMove")?.({
          clientX: 100 + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 2,
          clientY: 200,
        });
      });
      expect(hasClass(dlBtns[0]!, "hover-suppressed")).toBeFalse();

      // 点击删除按钮 -> 激活 hover-suppressed -> onMouseMove 纵向超阈值解除；再次点击后 onMouseLeave 解除。
      await act(async (): Promise<void> => {
        getReactPropHandler(delBtns[0]!, "onClick")?.({
          clientX: 50,
          clientY: 50,
          stopPropagation: (): void => {},
          currentTarget: { blur: (): void => {} },
        });
      });
      expect(deleted).toEqual([items[0]!.fileName]);
      expect(hasClass(delBtns[0]!, "hover-suppressed")).toBeTrue();
      await act(async (): Promise<void> => {
        getReactPropHandler(delBtns[0]!, "onMouseMove")?.({
          clientX: 50,
          clientY: 50 + MINI_APP_HOVER_SUPPRESS_RELEASE_DELTA_PX + 2,
        });
      });
      expect(hasClass(delBtns[0]!, "hover-suppressed")).toBeFalse();

      await act(async (): Promise<void> => {
        getReactPropHandler(delBtns[0]!, "onClick")?.({
          clientX: 10,
          clientY: 10,
          stopPropagation: (): void => {},
          currentTarget: { blur: (): void => {} },
        });
      });
      expect(hasClass(delBtns[0]!, "hover-suppressed")).toBeTrue();
      await act(async (): Promise<void> => {
        getReactPropHandler(dlBtns[0]!, "onMouseLeave")?.({});
      });
      expect(hasClass(delBtns[0]!, "hover-suppressed")).toBeFalse();

      await act(async (): Promise<void> => {
        getReactPropHandler(delBtns[0]!, "onClick")?.({
          clientX: 10,
          clientY: 10,
          stopPropagation: (): void => {},
          currentTarget: { blur: (): void => {} },
        });
      });
      await act(async (): Promise<void> => {
        getReactPropHandler(delBtns[0]!, "onMouseLeave")?.({});
      });
      expect(hasClass(delBtns[0]!, "hover-suppressed")).toBeFalse();

      // 切换挂载 GalleryPreviewCard：验证 ref/useEffect complete 探测、onLoad/onError 及下载/删除/关闭点击。
      let previewLoadedMarks: number = 0;
      let previewClosed: number = 0;
      const previewDl: string[] = [];
      const previewDel: string[] = [];
      imgCompleteFlag = true;
      await act(async (): Promise<void> => {
        root.render(
          createElement(GalleryPreviewCard, {
            previewItem: items[0]!,
            imageObjectUrl: "blob:https://mini.test/preview-1",
            previewLoaded: false,
            downloadingFileName: null,
            deletingFileName: null,
            onMarkPreviewLoaded: (): void => {
              previewLoadedMarks += 1;
            },
            onDownloadImage: (fileName: string): void => {
              previewDl.push(fileName);
            },
            onDeleteImage: (fileName: string): void => {
              previewDel.push(fileName);
            },
            onClosePreview: (): void => {
              previewClosed += 1;
            },
          })
        );
      });
      expect(previewLoadedMarks).toBeGreaterThanOrEqual(2);
      const previewImg: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "gallery-preview-img")
      )[0]!;
      await act(async (): Promise<void> => {
        getReactPropHandler(previewImg, "onLoad")?.({});
        getReactPropHandler(previewImg, "onError")?.({});
      });
      const previewActions: MiniDomNode[] = findElements(
        container,
        (el): boolean => el.tagName === "BUTTON"
      );
      expect(previewActions).toHaveLength(3);
      for (const btn of previewActions) {
        await act(async (): Promise<void> => {
          btn.triggerClick();
        });
      }
      expect(previewDl).toEqual([items[0]!.fileName]);
      expect(previewDel).toEqual([items[0]!.fileName]);
      expect(previewClosed).toBe(1);
    });
  });

  test("PaginationBar 覆盖首页/上页/下页/末页、每页条数切换、scrollTo、短暂 hover 定时清理与卸载取消", async () => {
    jest.useFakeTimers();
    const scrollCalls: unknown[] = [];
    const prevScrollToDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "scrollTo"
    );
    Object.defineProperty(globalThis, "scrollTo", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (opts: unknown): void => {
        scrollCalls.push(opts);
      },
    });
    const pageChanges: number[] = [];
    const sizeChanges: number[] = [];
    try {
      await withMountedDom(async ({ container, root }): Promise<void> => {
        await act(async (): Promise<void> => {
          root.render(
            createElement(PaginationBar, {
              page: 2,
              totalPages: 4,
              total: 40,
              pageSize: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[0]!,
              pageSizeOptions: MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
              onPageChange: (nextPage: number): void => {
                pageChanges.push(nextPage);
              },
              onPageSizeChange: (nextSize: number): void => {
                sizeChanges.push(nextSize);
              },
            })
          );
        });

        const sizeBtns: MiniDomNode[] = findElements(
          container,
          (el): boolean => hasClass(el, "page-size-pill")
        );
        // 点击当前已选档位不触发变更，点击另一档位触发 onPageSizeChange 与 scrollTo。
        await act(async (): Promise<void> => {
          sizeBtns[0]!.triggerClick();
          sizeBtns[1]!.triggerClick();
        });
        expect(sizeChanges).toEqual([MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS[1]!]);
        expect(hasClass(sizeBtns[1]!, "is-hovering")).toBeTrue();

        const navBtns: MiniDomNode[] = findElements(
          container,
          (el): boolean => hasClass(el, "page-btn")
        );
        expect(navBtns).toHaveLength(4);
        for (const btn of navBtns) {
          await act(async (): Promise<void> => {
            btn.triggerClick();
          });
        }
        expect(pageChanges).toEqual([1, 1, 3, 4]);
        expect(scrollCalls).toHaveLength(5);
        expect(hasClass(navBtns[3]!, "is-hovering")).toBeTrue();

        // 到达 hover 时限后清除 is-hovering。
        await act(async (): Promise<void> => {
          jest.advanceTimersByTime(MINI_APP_PAGINATION_HOVER_DURATION_MS);
        });
        expect(hasClass(navBtns[3]!, "is-hovering")).toBeFalse();

        // 再次点击激活定时器，随后卸载组件验证 cleanup 清理挂起定时器。
        await act(async (): Promise<void> => {
          navBtns[0]!.triggerClick();
        });
        expect(jest.getTimerCount()).toBeGreaterThan(0);
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      if (prevScrollToDesc !== undefined) {
        Object.defineProperty(globalThis, "scrollTo", prevScrollToDesc);
      } else {
        Reflect.deleteProperty(globalThis, "scrollTo");
      }
    }
  });

  test("ChatTargetsMenuButtonList 覆盖展开、点击三类目标项、遮罩关闭与退场拦截", async () => {
    jest.useFakeTimers();
    let toggleCalls: number = 0;
    let closeCalls: number = 0;
    const pickedKinds: MiniAppChatTargetKind[] = [];
    const detail: Readonly<MiniAppChatDetail> = sampleChatDetail();
    const targets: Readonly<MiniAppChatTargetsView> = {
      chatId: -1001,
      qaItems: [{ q: "q", a: "a" }],
      qaMax: CHAT_QA_MAX_PER_CHAT,
      qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
      qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
      deleteMessageTargets: [],
      deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
      translateTargets: [],
      translateMax: TRANSLATE_CHAT_USER_LIMIT,
      isTranslationEnabled: true,
    };

    await withMountedDom(async ({ container, root }): Promise<void> => {
      const renderMenu = async (open: boolean): Promise<void> => {
        await act(async (): Promise<void> => {
          root.render(
            createElement(ChatTargetsMenuButtonList, {
              targetsMenuOpen: open,
              chatDetail: detail,
              chatTargets: targets,
              t: zh,
              onToggleMenu: (): void => {
                toggleCalls += 1;
              },
              onCloseMenu: (): void => {
                closeCalls += 1;
              },
              onSelectTargetKind: (kind: MiniAppChatTargetKind): void => {
                pickedKinds.push(kind);
              },
            })
          );
        });
      };

      await renderMenu(true);
      const trigger: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-menu-btn")
      )[0]!;
      const backdrop: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-menu-backdrop")
      )[0]!;
      const menuItems: MiniDomNode[] = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-menu-item")
      );
      expect(menuItems).toHaveLength(3);

      await act(async (): Promise<void> => {
        trigger.triggerClick();
        backdrop.triggerClick();
        for (const itemBtn of menuItems) {
          itemBtn.triggerClick();
        }
      });
      expect(toggleCalls).toBe(1);
      expect(closeCalls).toBe(1);
      expect(pickedKinds).toEqual(["qa", "deleteMessage", "translate"]);

      // 关闭进入退场过渡：backdrop 带 closing 类且忽略点击；到期后卸载。
      await renderMenu(false);
      const closingBackdrop: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-menu-backdrop")
      )[0]!;
      expect(hasClass(closingBackdrop, "closing")).toBeTrue();
      await act(async (): Promise<void> => {
        closingBackdrop.triggerClick();
      });
      expect(closeCalls).toBe(1);
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MINI_APP_LANG_MENU_CLOSE_ANIMATION_MS);
      });
      expect(
        findElements(container, (el): boolean => hasClass(el, "chat-targets-menu-popover"))
      ).toHaveLength(0);
    });
  });

  test("CapabilityBlock 覆盖 memo 深度比较、sub 标签渲染、折叠切换与切换情绪回调", async () => {
    const toggled: string[] = [];
    let switched: number = 0;
    const slotRef: React.RefObject<ViewportAnchorScroll | null> = { current: null };
    const moodCap: Readonly<MiniAppCapabilityStatus> = {
      key: "mood",
      label: "AI 情绪",
      ready: true,
      detail: "ready",
      items: [
        { label: "calm", value: "权重 3", sub: "默认权重" },
        { label: "happy", value: "权重 2", sub: "活泼" },
      ],
    };
    const onToggle = (key: string): void => {
      toggled.push(key);
    };
    const onSwitch = (): void => {
      switched += 1;
    };

    await withMountedDom(async ({ container, root }): Promise<void> => {
      await act(async (): Promise<void> => {
        root.render(
          createElement(CapabilityBlock, {
            capability: moodCap,
            t: zh,
            isExpanded: false,
            onToggleCapability: onToggle,
            currentMood: "calm",
            switchingMood: false,
            onSwitchMood: onSwitch,
            followScrollSlotRef: slotRef,
          })
        );
      });
      expect(collectNodeText(container)).toContain("活泼");

      // 等价属性重渲染命中 areCapabilityBlockPropsEqual -> true。
      await act(async (): Promise<void> => {
        root.render(
          createElement(CapabilityBlock, {
            capability: { ...moodCap, items: [...moodCap.items] },
            t: zh,
            isExpanded: false,
            onToggleCapability: onToggle,
            currentMood: "calm",
            switchingMood: false,
            onSwitchMood: onSwitch,
            followScrollSlotRef: slotRef,
          })
        );
      });

      // 仅切换 isExpanded -> 外层重渲染，内部明细命中 areCapabilityDetailContentPropsEqual -> true。
      await act(async (): Promise<void> => {
        root.render(
          createElement(CapabilityBlock, {
            capability: { ...moodCap, items: [...moodCap.items] },
            t: zh,
            isExpanded: true,
            onToggleCapability: onToggle,
            currentMood: "calm",
            switchingMood: false,
            onSwitchMood: onSwitch,
            followScrollSlotRef: slotRef,
          })
        );
      });

      // 更改 currentMood -> 内部明细重渲染。
      await act(async (): Promise<void> => {
        root.render(
          createElement(CapabilityBlock, {
            capability: moodCap,
            t: zh,
            isExpanded: true,
            onToggleCapability: onToggle,
            currentMood: "happy",
            switchingMood: false,
            onSwitchMood: onSwitch,
            followScrollSlotRef: slotRef,
          })
        );
      });

      const headerBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "cap-header-btn")
      )[0]!;
      const switchBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "mood-switch-btn")
      )[0]!;
      await act(async (): Promise<void> => {
        headerBtn.triggerClick();
        switchBtn.triggerClick();
      });
      expect(toggled).toEqual(["mood"]);
      expect(switched).toBe(1);
    });
  });
});
