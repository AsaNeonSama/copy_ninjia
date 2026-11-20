/**
 * Mini App 前端原生选择器共享生命周期控制器与页面卸载中止测试：
 * 1. 验证 `store/nativePicker.ts` 在客户端不支持、预备期取消、轮询期取消、晚到回调与新选择覆盖旧轮询时的行为；
 * 2. 验证名单页与群目标页各自保留原有的超时提示色调（`"info"` 与 `"warning"`）；
 * 3. 验证 `IdentitiesPage` 卸载时通过 `cancelPendingPicker` 立即中止在途轮询且不产生登录页多余提示。
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
  MINI_APP_MIN_LOADING_MS,
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
} from "../../packages/mini-app-frontend/consts/miniApp";
import { getMiniAppTranslations } from "../../packages/mini-app-frontend/i18n";
import { clearMiniAppSessionToken } from "../../packages/mini-app-frontend/libs/credentials";
import { IdentitiesPage } from "../../packages/mini-app-frontend/pages/IdentitiesPage";
import { resetMiniAppStoreForTest, useMiniAppStore } from "../../packages/mini-app-frontend/store/app";
import { createChatsStore } from "../../packages/mini-app-frontend/store/chats";
import { createIdentitiesStore } from "../../packages/mini-app-frontend/store/identities";
import { resolveNativePickerWebApp } from "../../packages/mini-app-frontend/store/nativePicker";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
import { collectNodeText, findElements, installMiniDom } from "../helpers/miniAppDom";
import type { MiniDomEnvironment, MiniDomNode } from "../helpers/miniAppDom";
import {
  seedTestMiniAppSession,
  wrapEncryptedTestFetch,
} from "./helpers/encryptedFetchMock";

type RouteHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

const routes: Map<string, RouteHandler> = new Map<string, RouteHandler>();
const fetchCalls: string[] = [];
const originalFetch: typeof fetch = globalThis.fetch;
const zh: Readonly<MiniAppTranslations> = getMiniAppTranslations("zh");

function route(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}

function json(payload: unknown, status: number = 200): Response {
  return Response.json(payload, { status });
}

async function flushAsyncTicks(ticks: number = 6): Promise<void> {
  for (let i: number = 0; i < ticks; i += 1) {
    Bun.sleepSync(2);
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
  }
}

async function advancePickerTimeout(
  readPollCount: () => number
): Promise<void> {
  for (let attempt: number = 0; attempt < MINI_APP_PICKER_POLL_MAX_ATTEMPTS; attempt += 1) {
    const before: number = readPollCount();
    jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS);
    for (let spin: number = 0; spin < 40 && readPollCount() === before; spin += 1) {
      await flushAsyncTicks(1);
    }
    await flushAsyncTicks(4);
  }
}

function findButtonByText(container: MiniDomNode, text: string): MiniDomNode | null {
  const buttons: readonly MiniDomNode[] = findElements(
    container,
    (el: MiniDomNode): boolean => el.tagName === "BUTTON" && collectNodeText(el).includes(text)
  );
  return buttons[0] ?? null;
}

beforeEach((): void => {
  routes.clear();
  fetchCalls.length = 0;
  seedTestMiniAppSession("0".repeat(64), Date.now() + 600_000);
  globalThis.fetch = wrapEncryptedTestFetch((url: URL, init?: RequestInit): Response | Promise<Response> => {
    const key: string = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    fetchCalls.push(`${key}${url.search}`);
    const handler: RouteHandler | undefined = routes.get(key);
    if (handler === undefined) return json({ error: `no route ${key}` }, 404);
    return handler(url, init);
  });
  resetMiniAppStoreForTest();
  useMiniAppStore.getState().setLanguage("zh");
});

afterEach((): void => {
  jest.useRealTimers();
  (globalThis as { Telegram?: unknown }).Telegram = undefined;
  globalThis.fetch = originalFetch;
  resetMiniAppStoreForTest();
  clearMiniAppSessionToken();
});

describe("Mini App 原生选择器共享生命周期控制器", () => {
  test("不支持 requestChat 时给出警告提示并返回 null", () => {
    (globalThis as { Telegram?: unknown }).Telegram = { WebApp: {} };
    expect(resolveNativePickerWebApp()).toBeNull();
    expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerUnsupportedHint);
    expect(useMiniAppStore.getState().toastTone).toBe("warning");
  });

  test("卸载取消立即中止轮询并作废预备与晚到回调，名单与群目标各自保留原有超时提示色调", async () => {
    jest.useFakeTimers();
    const requestChatCalls: { readonly id: string; readonly cb: (accepted: boolean) => void }[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        requestChat: (id: string, cb: (accepted: boolean) => void): void => {
          requestChatCalls.push({ id, cb });
        },
      },
    };

    let prepareSeq: number = 100;
    let resultPollCount: number = 0;
    route("GET /api/picker/result", (): Response => {
      resultPollCount += 1;
      return json({ result: null });
    });

    const identitiesStore = createIdentitiesStore();
    const chatsStore = createChatsStore();
    try {
      const prepareGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
      route("POST /api/picker/prepare", async (): Promise<Response> => {
        await prepareGate.promise;
        prepareSeq += 1;
        return json({ ok: true, requestId: prepareSeq, preparedButtonId: `btn-${prepareSeq}` });
      });
      identitiesStore.getState().selectAddMode("users");
      await flushAsyncTicks(3);
      identitiesStore.getState().cancelPendingPicker();
      prepareGate.resolve();
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(0);

      route("POST /api/picker/prepare", (): Response => {
        prepareSeq += 1;
        return json({ ok: true, requestId: prepareSeq, preparedButtonId: `btn-${prepareSeq}` });
      });
      identitiesStore.getState().selectAddMode("users");
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(1);
      requestChatCalls[0]!.cb(true);
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerWaitingToast);

      useMiniAppStore.getState().clearToast();
      clearMiniAppSessionToken();
      identitiesStore.getState().cancelPendingPicker();
      jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS * 3);
      await flushAsyncTicks();
      expect(resultPollCount).toBe(0);
      expect(useMiniAppStore.getState().toastText).toBe("");

      requestChatCalls[0]!.cb(true);
      jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS * 2);
      await flushAsyncTicks();
      expect(resultPollCount).toBe(0);
      expect(useMiniAppStore.getState().toastText).toBe("");

      seedTestMiniAppSession("0".repeat(64), Date.now() + 600_000);
      identitiesStore.getState().selectAddMode("users");
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(2);
      requestChatCalls[1]!.cb(true);
      await advancePickerTimeout((): number => resultPollCount);
      expect(resultPollCount).toBe(MINI_APP_PICKER_POLL_MAX_ATTEMPTS);
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerTimeoutToast);
      expect(useMiniAppStore.getState().toastTone).toBe("info");

      chatsStore.setState({
        selectedChatId: -100,
        activeTargetsModal: "deleteMessage",
        chatDetail: {
          chatId: -100,
          title: "Test",
          features: { init: true, translation: true } as never,
          botPermissions: { canDeleteMessages: true, grantedLabels: [] } as never,
        } as never,
      });
      const resultCallsBeforeChats: number = resultPollCount;

      chatsStore.getState().selectTargetAddMode("users");
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(3);
      requestChatCalls[2]!.cb(true);
      useMiniAppStore.getState().clearToast();
      chatsStore.getState().cancelPendingRefresh();
      jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS * 3);
      await flushAsyncTicks();
      expect(resultPollCount).toBe(resultCallsBeforeChats);
      expect(useMiniAppStore.getState().toastText).toBe("");

      chatsStore.getState().selectTargetAddMode("users");
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(4);
      requestChatCalls[3]!.cb(true);
      chatsStore.getState().selectTargetAddMode("channel");
      await flushAsyncTicks();
      expect(requestChatCalls).toHaveLength(5);
      requestChatCalls[4]!.cb(true);
      await advancePickerTimeout((): number => resultPollCount);
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerTimeoutToast);
      expect(useMiniAppStore.getState().toastTone).toBe("warning");
      expect(resultPollCount).toBe(resultCallsBeforeChats + MINI_APP_PICKER_POLL_MAX_ATTEMPTS);
    } finally {
      identitiesStore.getState().cancelPendingPicker();
      chatsStore.getState().cancelPendingRefresh();
    }
  });

  test("IdentitiesPage 卸载时立即中止在途原生选择器轮询且不再发出查询或弹出提示", async () => {
    const activeCallbacks: ((accepted: boolean) => void)[] = [];
    (globalThis as { Telegram?: unknown }).Telegram = {
      WebApp: {
        requestChat: (_preparedButtonId: string, callback: (accepted: boolean) => void): void => {
          activeCallbacks.push(callback);
        },
      },
    };
    route("GET /api/identities/whitelist", (): Response =>
      json({
        items: [],
        page: 1,
        pageSize: MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
        total: 0,
        totalPages: 1,
        whitelistTotal: 0,
        blocklistTotal: 0,
        nextAfterId: null,
      })
    );
    route("POST /api/picker/prepare", (): Response =>
      json({ ok: true, requestId: 202, preparedButtonId: "btn-unmount-users" })
    );
    let resultPollsAfterUnmount: number = 0;
    route("GET /api/picker/result", (): Response => {
      resultPollsAfterUnmount += 1;
      return json({ result: null });
    });

    jest.useFakeTimers();
    const env: MiniDomEnvironment = installMiniDom();
    try {
      const container: MiniDomNode = env.document.createElement("div");
      const root: Root = createRoot(container as unknown as Element);
      await act(async (): Promise<void> => {
        root.render(createElement(IdentitiesPage));
      });
      await act(async (): Promise<void> => {
        await flushAsyncTicks();
        jest.advanceTimersByTime(MINI_APP_MIN_LOADING_MS);
        await flushAsyncTicks();
      });

      const foldBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addFoldButton);
      expect(foldBtn).not.toBeNull();
      await act(async (): Promise<void> => {
        foldBtn!.triggerClick();
      });
      const pickUsersBtn: MiniDomNode | null = findButtonByText(container, zh.identities.addModes.users);
      expect(pickUsersBtn).not.toBeNull();
      await act(async (): Promise<void> => {
        pickUsersBtn!.triggerClick();
        await flushAsyncTicks();
      });
      expect(activeCallbacks).toHaveLength(1);
      await act(async (): Promise<void> => {
        activeCallbacks[0]!(true);
      });
      expect(useMiniAppStore.getState().toastText).toBe(zh.identities.pickerWaitingToast);

      useMiniAppStore.getState().clearToast();
      clearMiniAppSessionToken();
      await act(async (): Promise<void> => {
        root.unmount();
      });
      jest.advanceTimersByTime(MINI_APP_PICKER_POLL_INTERVAL_MS * 3);
      await flushAsyncTicks();
      expect(resultPollsAfterUnmount).toBe(0);
      expect(useMiniAppStore.getState().toastText).toBe("");
    } finally {
      jest.useRealTimers();
      env.restore();
    }
  });
});
