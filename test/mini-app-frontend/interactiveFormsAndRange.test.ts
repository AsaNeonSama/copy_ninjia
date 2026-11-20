/**
 * Mini App 前端表单、名单行与弹性滑块动画 Hook 真实挂载 DOM 事件测试：
 * 覆盖 `ChatTargetsMemberPanels` / `ChatTargetsMemberAddForm`、`IdentitySearchAndAddCard`、
 * `IdentityListRows`（含 `BlocklistEntryRowList` 与 `useRetainedClosingWhitelistItems`）、
 * `ChatJoinCleanCard` 与 `useAnimatedRangeProgress` 的真实挂载与交互事件处理器。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement, useState } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { ChatJoinCleanCard } from "../../packages/mini-app-frontend/components/ChatJoinCleanCard";
import {
  ChatTargetsMemberAddForm,
  ChatTargetsMemberPanels,
} from "../../packages/mini-app-frontend/components/ChatTargetsMemberPanels";
import {
  BlocklistEntryRowList,
  useRetainedClosingWhitelistItems,
  WhitelistEntryRowList,
} from "../../packages/mini-app-frontend/components/IdentityListRows";
import { IdentitySearchAndAddCard } from "../../packages/mini-app-frontend/components/IdentitySearchAndAddCard";
import {
  resolveAnimatedRangeStartValue,
  useAnimatedRangeProgress,
} from "../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import type { AnimatedRangeProgressResult } from "../../packages/mini-app-frontend/components/animations/useAnimatedRangeProgress";
import { VERBATIM_CONTEXT_MAX } from "../../packages/mini-app-frontend/consts/memory";
import {
  CHAT_QA_ANSWER_MAX_CHARS,
  CHAT_QA_MAX_PER_CHAT,
  CHAT_QA_QUESTION_MAX_CHARS,
  DELETE_MESSAGE_CHAT_TARGET_MAX,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_PRESET_HOURS,
  MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS,
  MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS,
  MINI_APP_SEARCH_DEBOUNCE_MS,
  TRANSLATE_CHAT_USER_LIMIT,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/mini-app-frontend/consts/whitelist";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import type {
  ChatTargetsMemberAddFormSlice,
  ChatTargetsMemberPanelsSlice,
} from "../../packages/mini-app-frontend/types/chatTargets";
import type { WhitelistPermissionKey } from "../../packages/mini-app-frontend/types/identityPolicy";
import type {
  MiniAppBlocklistEntryView,
  MiniAppChatDetail,
  MiniAppTranslateLanguage,
  MiniAppWhitelistEntryView,
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

/** 构造全 false 或仅指定键为 true 的 18 项白名单权限表。 */
function buildPermissions(
  enabledKeys: readonly WhitelistPermissionKey[] = []
): Record<WhitelistPermissionKey, boolean> {
  const set: ReadonlySet<WhitelistPermissionKey> = new Set(enabledKeys);
  return Object.fromEntries(
    WHITELIST_PERMISSION_KEYS.map((key: WhitelistPermissionKey): readonly [WhitelistPermissionKey, boolean] => [
      key,
      set.has(key),
    ])
  ) as Record<WhitelistPermissionKey, boolean>;
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

describe("Mini App 前端表单、名单行与滑块动画 Hook 真实挂载 DOM 事件测试", () => {
  test("ChatTargetsMemberPanels 与 ChatTargetsMemberAddForm 覆盖骨架态、语言菜单、输入提交、移除与退场保护", async () => {
    const detail: Readonly<MiniAppChatDetail> = sampleChatDetail();
    const removedDelete: number[] = [];
    const removedTranslate: number[] = [];
    let closedAddMenu: number = 0;
    let toggledLangMenu: number = 0;
    const selectedLangs: MiniAppTranslateLanguage[] = [];
    const deleteInputs: string[] = [];
    const translateInputs: string[] = [];
    let submittedDelete: number = 0;
    let submittedTranslate: number = 0;

    const panelState = (loadingTargets: boolean): ChatTargetsMemberPanelsSlice => ({
      chatTargets: {
        chatId: -1001,
        qaItems: [],
        qaMax: CHAT_QA_MAX_PER_CHAT,
        qaQuestionMaxChars: CHAT_QA_QUESTION_MAX_CHARS,
        qaAnswerMaxChars: CHAT_QA_ANSWER_MAX_CHARS,
        deleteMessageTargets: [
          { id: 101, isChannel: false, displayName: "DelUser", username: "del_u" },
        ],
        deleteMessageMax: DELETE_MESSAGE_CHAT_TARGET_MAX,
        translateTargets: [
          { id: -1002, isChannel: true, displayName: "TransChan", language: "en" },
        ],
        translateMax: TRANSLATE_CHAT_USER_LIMIT,
        isTranslationEnabled: true,
      },
      loadingTargets,
      mutatingTargets: false,
      removeDeleteTarget: async (id: number): Promise<void> => {
        removedDelete.push(id);
      },
      removeTranslateTarget: async (id: number): Promise<void> => {
        removedTranslate.push(id);
      },
    });

    const addFormState: ChatTargetsMemberAddFormSlice = {
      mutatingTargets: false,
      preparingPickerMode: null,
      targetAddMenuOpen: true,
      targetIdFormOpen: true,
      deleteTargetInput: "555",
      translateTargetInput: "666",
      translateLanguageInput: "cn",
      translateLangMenuOpen: true,
      closeTargetAddMenu: (): void => {
        closedAddMenu += 1;
      },
      selectTargetAddMode: (): void => {},
      setDeleteTargetInput: (v: string): void => {
        deleteInputs.push(v);
      },
      setTranslateTargetInput: (v: string): void => {
        translateInputs.push(v);
      },
      setTranslateLanguageInput: (lang: MiniAppTranslateLanguage): void => {
        selectedLangs.push(lang);
      },
      toggleTranslateLangMenu: (): void => {
        toggledLangMenu += 1;
      },
      submitDeleteTarget: async (): Promise<void> => {
        submittedDelete += 1;
      },
      submitTranslateTarget: async (): Promise<void> => {
        submittedTranslate += 1;
      },
    };

    await withMountedDom(async ({ container, root }): Promise<void> => {
      // 1. 加载骨架态。
      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberPanels, {
            kind: "deleteMessage",
            chatDetail: detail,
            state: panelState(true),
            t: zh,
          })
        );
      });
      expect(findElements(container, (el): boolean => hasClass(el, "skeleton-line")).length).toBeGreaterThan(0);

      // 2. deleteMessage 列表正常点击移除与 isClosing 屏蔽点击。
      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberPanels, {
            kind: "deleteMessage",
            chatDetail: detail,
            state: panelState(false),
            isClosing: false,
            t: zh,
          })
        );
      });
      findButtonByText(container, zh.chats.deleteTargetRemoveButton)!.triggerClick();
      expect(removedDelete).toEqual([101]);

      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberPanels, {
            kind: "deleteMessage",
            chatDetail: detail,
            state: panelState(false),
            isClosing: true,
            t: zh,
          })
        );
      });
      findButtonByText(container, zh.chats.deleteTargetRemoveButton)!.triggerClick();
      expect(removedDelete).toEqual([101]);

      // 3. translate 列表点击移除。
      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberPanels, {
            kind: "translate",
            chatDetail: detail,
            state: panelState(false),
            t: zh,
          })
        );
      });
      findButtonByText(container, zh.chats.translateTargetRemoveButton)!.triggerClick();
      expect(removedTranslate).toEqual([-1002]);

      // 4. ChatTargetsMemberAddForm（translate 正常态与 isClosing 守卫）。
      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberAddForm, {
            kind: "translate",
            state: addFormState,
            isClosing: false,
            t: zh,
          })
        );
      });
      const langDropdown: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-lang-dropdown")
      )[0]!;
      const langTrigger: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-lang-trigger")
      )[0]!;
      const langOption: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-lang-option")
      )[1]!;
      const cancelBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-cancel-btn")
      )[0]!;
      const inputEl: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-input")
      )[0]!;
      const submitBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-inline-btn")
      )[0]!;
      let stopped: number = 0;
      await act(async (): Promise<void> => {
        getReactPropHandler(langDropdown, "onClick")?.({
          stopPropagation: (): void => {
            stopped += 1;
          },
        });
        langTrigger.triggerClick();
        langOption.triggerClick();
        cancelBtn.triggerClick();
        getReactPropHandler(inputEl, "onChange")?.({ currentTarget: { value: "777" } });
        submitBtn.triggerClick();
      });
      expect(stopped).toBe(1);
      expect(toggledLangMenu).toBe(1);
      expect(selectedLangs).toHaveLength(1);
      expect(closedAddMenu).toBe(1);
      expect(translateInputs).toEqual(["777"]);
      expect(submittedTranslate).toBe(1);

      // 退场阶段 isClosing=true 屏蔽所有交互回调。
      await act(async (): Promise<void> => {
        root.render(
          createElement(ChatTargetsMemberAddForm, {
            kind: "deleteMessage",
            state: addFormState,
            isClosing: true,
            t: zh,
          })
        );
      });
      const closingCancel: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-cancel-btn")
      )[0]!;
      const closingInput: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-input")
      )[0]!;
      const closingSubmit: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "chat-targets-inline-btn")
      )[0]!;
      await act(async (): Promise<void> => {
        closingCancel.triggerClick();
        getReactPropHandler(closingInput, "onChange")?.({ currentTarget: { value: "888" } });
        closingSubmit.triggerClick();
      });
      expect(closedAddMenu).toBe(1);
      expect(deleteInputs).toEqual([]);
      expect(submittedDelete).toBe(0);
    });
  });

  test("IdentitySearchAndAddCard 覆盖防抖搜索、IME 组合输入、回车直提交、清空按钮与按 ID 添加表单交互", async () => {
    jest.useFakeTimers();
    const store = createIdentitiesStore();
    await withMountedDom(async ({ container, root }): Promise<void> => {
      await act(async (): Promise<void> => {
        root.render(createElement(IdentitySearchAndAddCard, { store }));
      });
      const searchInput: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "search-input")
      )[0]!;

      // 1. IME 组合输入期间暂停防抖且忽略 Enter；组合结束后更新输入并按防抖提交。
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onCompositionStart")?.({});
        getReactPropHandler(searchInput, "onChange")?.({ currentTarget: { value: "ni" } });
        getReactPropHandler(searchInput, "onKeyDown")?.({
          key: "Enter",
          preventDefault: (): void => {},
        });
      });
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MINI_APP_SEARCH_DEBOUNCE_MS + 50);
      });
      expect(store.getState().debouncedQuery).toBe("");

      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onCompositionEnd")?.({
          currentTarget: { value: "doro" },
        });
      });
      expect(store.getState().searchInput).toBe("doro");
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MINI_APP_SEARCH_DEBOUNCE_MS);
      });
      expect(store.getState().debouncedQuery).toBe("doro");

      // 2. 非组合输入态按 Enter 立即提交。
      let prevented: number = 0;
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onChange")?.({ currentTarget: { value: " alice " } });
      });
      await act(async (): Promise<void> => {
        getReactPropHandler(searchInput, "onKeyDown")?.({
          key: "Enter",
          preventDefault: (): void => {
            prevented += 1;
          },
        });
      });
      expect(prevented).toBe(1);
      expect(store.getState().debouncedQuery).toBe("alice");

      // 3. 清空按钮 onMouseDown 阻止失焦、onClick 清空搜索词。
      const clearBtn: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "search-clear-btn")
      )[0]!;
      let mouseDownPrevented: number = 0;
      await act(async (): Promise<void> => {
        getReactPropHandler(clearBtn, "onMouseDown")?.({
          preventDefault: (): void => {
            mouseDownPrevented += 1;
          },
        });
        clearBtn.triggerClick();
      });
      expect(mouseDownPrevented).toBe(1);
      expect(store.getState().searchInput).toBe("");
      expect(store.getState().debouncedQuery).toBe("");

      // 4. 展开添加抽屉 -> 选按 ID 添加 -> 输入非法 ID 并点击确认（触发校验提示）-> 点击取消。
      const foldTrigger: MiniDomNode = findElements(
        container,
        (el): boolean => hasClass(el, "add-fold-trigger")
      )[0]!;
      await act(async (): Promise<void> => {
        foldTrigger.triggerClick();
      });
      expect(store.getState().addMenuOpen).toBeTrue();
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.addModes.id)!.triggerClick();
      });
      expect(store.getState().idFormOpen).toBeTrue();
      const idInput: MiniDomNode = findElements(
        container,
        (el): boolean => el.tagName === "INPUT" && !hasClass(el, "search-input")
      )[0]!;
      await act(async (): Promise<void> => {
        getReactPropHandler(idInput, "onChange")?.({ currentTarget: { value: "bad-id" } });
      });
      expect(store.getState().idInput).toBe("bad-id");
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.idConfirmButton)!.triggerClick();
      });
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.invalidIdToast);
      await act(async (): Promise<void> => {
        findButtonByText(container, zh.identities.idCancelButton)!.triggerClick();
      });
      expect(store.getState().idFormOpen).toBeFalse();
    });
  });

  test("IdentityListRows 覆盖白名单行交互/收起保护、useRetainedClosingWhitelistItems 与 BlocklistEntryRowList", async () => {
    jest.useFakeTimers();
    const wlItems: readonly Readonly<MiniAppWhitelistEntryView>[] = [
      {
        id: 101,
        isChannel: false,
        displayName: "Alice",
        username: "alice",
        permissions: buildPermissions([WHITELIST_PERMISSION_KEYS[0]!]),
      },
      {
        id: -100999,
        isChannel: true,
        displayName: "ChannelNoUser",
        permissions: buildPermissions(),
      },
    ];
    const blItems: readonly Readonly<MiniAppBlocklistEntryView>[] = [
      {
        id: 201,
        isChannel: false,
        displayName: "SpamUser",
        username: "spammer",
        blockedAt: "2026/05/01 00:00:00",
      },
      {
        id: -100888,
        isChannel: true,
        displayName: "SpamChannel",
        blockedAt: "2026/05/02 00:00:00",
      },
    ];
    const toggledDrawers: number[] = [];
    const removedWl: number[] = [];
    const removedBl: number[] = [];

    await withMountedDom(async ({ container, root }): Promise<void> => {
      // 1. WhitelistEntryRowList：用户行展开抽屉、频道行点击配置与移除，closingEntryId 屏蔽点击。
      await act(async (): Promise<void> => {
        root.render(
          createElement(WhitelistEntryRowList, {
            items: wlItems,
            selectedEntryId: 101,
            closingEntryId: -100999,
            busyAction: false,
            t: zh,
            onTogglePermissionDrawer: (id: number): void => {
              toggledDrawers.push(id);
            },
            onClosePermissionDrawer: (): void => {},
            onPermissionsUpdated: (): void => {},
            onRemoveWhitelist: async (entry: Readonly<MiniAppWhitelistEntryView>): Promise<void> => {
              removedWl.push(entry.id);
            },
          })
        );
      });
      expect(collectNodeText(container)).toContain(zh.identities.channelBadge);
      expect(findElements(container, (el): boolean => hasClass(el, "perm-drawer-inline"))).toHaveLength(1);

      const permButtons: MiniDomNode[] = findElements(
        container,
        (el): boolean => el.tagName === "BUTTON" && collectNodeText(el) === zh.identities.configurePermButton
      );
      const removeButtons: MiniDomNode[] = findElements(
        container,
        (el): boolean => el.tagName === "BUTTON" && collectNodeText(el).includes(zh.identities.removeWhitelistButton)
      );
      await act(async (): Promise<void> => {
        permButtons[0]!.triggerClick();
        permButtons[1]!.triggerClick();
        removeButtons[0]!.triggerClick();
        removeButtons[1]!.triggerClick();
      });
      // 第 2 行处于 closingEntryId，点击被拦截；仅第 1 行生效。
      expect(toggledDrawers).toEqual([101]);
      expect(removedWl).toEqual([101]);

      // 2. useRetainedClosingWhitelistItems：展开条目被移出后在保留期内插回，到期后卸载，不存在的选中 ID 返回 null。
      let latestRetained: { readonly ids: readonly number[]; readonly closingId: number | null } = {
        ids: [],
        closingId: null,
      };
      const RetainedProbe = (props: {
        readonly items: readonly Readonly<MiniAppWhitelistEntryView>[];
        readonly selectedEntryId: number | null;
      }): React.JSX.Element => {
        const state = useRetainedClosingWhitelistItems(props.items, props.selectedEntryId, "ctx:1");
        latestRetained = {
          ids: state.items.map((item): number => item.id),
          closingId: state.closingEntryId,
        };
        return createElement("div");
      };
      await act(async (): Promise<void> => {
        root.render(createElement(RetainedProbe, { items: wlItems, selectedEntryId: 999999 }));
      });
      expect(latestRetained.closingId).toBeNull();
      await act(async (): Promise<void> => {
        root.render(createElement(RetainedProbe, { items: wlItems, selectedEntryId: 101 }));
      });
      await act(async (): Promise<void> => {
        root.render(createElement(RetainedProbe, { items: [wlItems[1]!], selectedEntryId: null }));
      });
      expect(latestRetained).toEqual({ ids: [101, -100999], closingId: 101 });
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MINI_APP_FLIP_COLLAPSE_CONTENT_RETAIN_MS);
      });
      expect(latestRetained).toEqual({ ids: [-100999], closingId: null });

      // 3. BlocklistEntryRowList：用户/频道条目渲染与解封按钮点击。
      await act(async (): Promise<void> => {
        root.render(
          createElement(BlocklistEntryRowList, {
            items: blItems,
            busyAction: false,
            t: zh,
            onRemoveBlocklist: async (entry: Readonly<MiniAppBlocklistEntryView>): Promise<void> => {
              removedBl.push(entry.id);
            },
          })
        );
      });
      const text: string = collectNodeText(container);
      expect(text).toContain("SpamUser");
      expect(text).toContain("@spammer");
      expect(text).toContain("SpamChannel");
      expect(text).toContain(zh.identities.channelBadge);
      const blRemoveBtns: MiniDomNode[] = findElements(
        container,
        (el): boolean => el.tagName === "BUTTON"
      );
      expect(blRemoveBtns).toHaveLength(2);
      await act(async (): Promise<void> => {
        blRemoveBtns[0]!.triggerClick();
        blRemoveBtns[1]!.triggerClick();
      });
      expect(removedBl).toEqual([201, -100888]);
    });
  });

  test("ChatJoinCleanCard 与 useAnimatedRangeProgress 覆盖步进/预设 RAF 弹性循环、手动拖拽中断与无 RAF 回退", async () => {
    // 1. resolveAnimatedRangeStartValue 同目标与普通距离直接返回分支。
    expect(resolveAnimatedRangeStartValue(6, 6, 6)).toBe(6);
    expect(resolveAnimatedRangeStartValue(3, 3, 12)).toBe(3);

    const prevRafDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame"
    );
    const prevCancelDesc: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
      globalThis,
      "cancelAnimationFrame"
    );
    let nextFrameId: number = 1;
    const rafQueue: Map<number, (now: number) => void> = new Map<number, (now: number) => void>();
    const cancelledIds: number[] = [];
    const installStubRaf = (): void => {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (cb: (now: number) => void): number => {
          const id: number = nextFrameId;
          nextFrameId += 1;
          rafQueue.set(id, cb);
          return id;
        },
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (id: number): void => {
          cancelledIds.push(id);
          rafQueue.delete(id);
        },
      });
    };

    try {
      installStubRaf();
      await withMountedDom(async ({ container, root }): Promise<void> => {
        // A. 挂载 ChatJoinCleanCard 验证 − / + / 预设 / range 拖拽 / 触发清理按钮事件处理器。
        const chatsStore = createChatsStore();
        chatsStore.setState({ selectedChatId: -1001, batchKickHours: 6 });
        await act(async (): Promise<void> => {
          root.render(
            createElement(ChatJoinCleanCard, {
              chatDetail: sampleChatDetail(),
              store: chatsStore,
            })
          );
        });
        const stepBtns: MiniDomNode[] = findElements(
          container,
          (el): boolean => hasClass(el, "join-clean-step-btn")
        );
        const presetBtns: MiniDomNode[] = findElements(
          container,
          (el): boolean => hasClass(el, "join-clean-preset-btn")
        );
        const rangeInput: MiniDomNode = findElements(
          container,
          (el): boolean => hasClass(el, "join-clean-range")
        )[0]!;
        const triggerBtn: MiniDomNode = findElements(
          container,
          (el): boolean => hasClass(el, "join-clean-trigger-btn")
        )[0]!;

        await act(async (): Promise<void> => {
          stepBtns[0]!.triggerClick();
        });
        expect(chatsStore.getState().batchKickHours).toBe(5);
        expect(hasClass(rangeInput, "is-animating")).toBeTrue();

        await act(async (): Promise<void> => {
          stepBtns[1]!.triggerClick();
        });
        expect(chatsStore.getState().batchKickHours).toBe(6);

        await act(async (): Promise<void> => {
          presetBtns[presetBtns.length - 1]!.triggerClick();
        });
        expect(chatsStore.getState().batchKickHours).toBe(
          MINI_APP_BATCH_KICK_PRESET_HOURS[MINI_APP_BATCH_KICK_PRESET_HOURS.length - 1]!
        );

        await act(async (): Promise<void> => {
          getReactPropHandler(rangeInput, "onChange")?.({ currentTarget: { value: "9" } });
        });
        expect(chatsStore.getState().batchKickHours).toBe(9);
        expect(hasClass(rangeInput, "is-animating")).toBeFalse();

        await act(async (): Promise<void> => {
          triggerBtn.triggerClick();
        });
        expect(useMiniAppStore.getState().confirmModal).not.toBeNull();
        useMiniAppStore.getState().resolveConfirm(false);
        chatsStore.getState().cancelPendingRefresh();

        // B. 挂载 useAnimatedRangeProgress 探针：覆盖完整 RAF 帧推进、非有限时间戳兜底、手动拖拽打断与卸载清理。
        rafQueue.clear();
        cancelledIds.length = 0;
        let latestResult: AnimatedRangeProgressResult | null = null;
        const RangeProbe = (): React.JSX.Element => {
          const [hours, setHours] = useState<number>(MINI_APP_BATCH_KICK_MIN_HOURS);
          latestResult = useAnimatedRangeProgress(hours, setHours);
          return createElement("div");
        };
        await act(async (): Promise<void> => {
          root.render(createElement(RangeProbe));
        });
        expect(latestResult!.displayValue).toBe(MINI_APP_BATCH_KICK_MIN_HOURS);

        // 步进至 12h，推进首帧、中段帧与终点帧（进度 >= 1）。
        await act(async (): Promise<void> => {
          latestResult!.onButtonStepChange(12);
        });
        expect(latestResult!.isAnimating).toBeTrue();
        expect(rafQueue.size).toBe(1);

        const firstEntry = [...rafQueue.entries()][0]!;
        rafQueue.delete(firstEntry[0]);
        await act(async (): Promise<void> => {
          firstEntry[1](1_000);
        });
        expect(latestResult!.isAnimating).toBeTrue();
        expect(rafQueue.size).toBe(1);

        const midEntry = [...rafQueue.entries()][0]!;
        rafQueue.delete(midEntry[0]);
        await act(async (): Promise<void> => {
          midEntry[1](1_000 + Math.floor(MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS / 2));
        });
        expect(latestResult!.isAnimating).toBeTrue();

        const finalEntry = [...rafQueue.entries()][0]!;
        rafQueue.delete(finalEntry[0]);
        await act(async (): Promise<void> => {
          finalEntry[1](1_000 + MINI_APP_BATCH_KICK_RANGE_ANIMATION_MS + 100);
        });
        expect(latestResult!.isAnimating).toBeFalse();
        expect(latestResult!.displayValue).toBe(12);

        // 非有限时间戳 NaN 回退至 Date.now()，随后手动拖拽（含 NaN 夹紧）取消在途 RAF 并立即落定。
        await act(async (): Promise<void> => {
          latestResult!.onButtonStepChange(20);
        });
        expect(rafQueue.size).toBe(1);
        const nanEntry = [...rafQueue.entries()][0]!;
        rafQueue.delete(nanEntry[0]);
        await act(async (): Promise<void> => {
          nanEntry[1](Number.NaN);
        });
        expect(rafQueue.size).toBe(1);
        await act(async (): Promise<void> => {
          latestResult!.onManualDragChange(Number.NaN);
        });
        expect(latestResult!.isAnimating).toBeFalse();
        expect(latestResult!.displayValue).toBe(MINI_APP_BATCH_KICK_MIN_HOURS);
        expect(cancelledIds.length).toBeGreaterThan(0);

        // 触发新一轮动画后卸载，验证 effect cleanup 取消在途 RAF。
        await act(async (): Promise<void> => {
          latestResult!.onButtonStepChange(Number.NaN);
          latestResult!.onButtonStepChange(16);
        });
        expect(rafQueue.size).toBe(1);
      });
      expect(rafQueue.size).toBe(0);

      // C. 无 requestAnimationFrame 环境直接跳至目标值不报错。
      Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      await withMountedDom(async ({ root }): Promise<void> => {
        let fallbackResult: AnimatedRangeProgressResult | null = null;
        const FallbackProbe = (): React.JSX.Element => {
          const [hours, setHours] = useState<number>(2);
          fallbackResult = useAnimatedRangeProgress(hours, setHours);
          return createElement("div");
        };
        await act(async (): Promise<void> => {
          root.render(createElement(FallbackProbe));
        });
        await act(async (): Promise<void> => {
          fallbackResult!.onButtonStepChange(10);
        });
        expect(fallbackResult!.displayValue).toBe(10);
        expect(fallbackResult!.isAnimating).toBeFalse();
      });
    } finally {
      if (prevRafDesc !== undefined) {
        Object.defineProperty(globalThis, "requestAnimationFrame", prevRafDesc);
      } else {
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      }
      if (prevCancelDesc !== undefined) {
        Object.defineProperty(globalThis, "cancelAnimationFrame", prevCancelDesc);
      } else {
        Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      }
    }
  });
});
