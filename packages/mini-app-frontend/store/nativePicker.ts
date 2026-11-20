import { waitForMiniAppPickerResult } from "../api/pickerResult";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { getTelegramWebApp } from "../libs/telegram";
import type { TelegramWebApp } from "../types/miniApp/host";
import type { MiniAppPickerResultEvent } from "../types/miniApp/identities";
import { useMiniAppStore } from "./app";
import type { MiniAppToastTone } from "./app";

/** 已确认支持 `requestChat` 方法的 Telegram WebApp 宿主句柄。 */
export type NativePickerCapableWebApp = Readonly<TelegramWebApp> & {
  readonly requestChat: NonNullable<TelegramWebApp["requestChat"]>;
};

/** 唤起 Telegram 原生选择器并轮询结果回执的入参。 */
export interface LaunchMiniAppNativePickerOptions {
  /** 支持 `requestChat` 的 Telegram WebApp 宿主句柄。 */
  readonly webApp: NativePickerCapableWebApp;
  /** 服务端预备接口返回的按钮 ID。 */
  readonly preparedButtonId: string;
  /** 服务端预备接口返回的轮询请求 ID。 */
  readonly requestId: number;
  /** 可选预备前捕获的代次号；与控制器当前代次不一致时跳过唤起。 */
  readonly expectedEpoch?: number;
  /** 轮询超时提示的 Toast 色调（缺省沿用根仓库默认 `"info"`）。 */
  readonly timeoutTone?: MiniAppToastTone;
  /** 收到有效选择器回执后的回调。 */
  readonly onResult: (
    outcome: Readonly<MiniAppPickerResultEvent>
  ) => Promise<void> | void;
}

/** 单个页面仓库持有的原生选择器轮询生命周期控制器。 */
export interface MiniAppNativePickerController {
  /** 读取当前控制器代次号，用于在异步预备请求前后判断页面是否已卸载或取消。 */
  readonly captureEpoch: () => number;
  /**
   * 唤起 Telegram 原生选择器，并在用户确认后携带 `AbortSignal` 轮询结果回执：
   * - 若指定了 `expectedEpoch` 且已与当前代次不一致，直接忽略；
   * - 新一次唤起会中止同一控制器上尚未结束的旧轮询；
   * - 用户取消时弹出取消提示，确认后弹出等待提示并开始轮询；
   * - 轮询被 `cancel()` 中止时静默结束，不触发超时或错误提示；
   * - 轮询超时按 `timeoutTone` 提示，异常按 `"warning"` 提示，收到回执时调用 `onResult`。
   */
  readonly launch: (options: Readonly<LaunchMiniAppNativePickerOptions>) => void;
  /** 中止当前在途的轮询并作废尚未触发的原生选择器回调（供页面卸载清理使用）。 */
  readonly cancel: () => void;
}

/**
 * 判断 Telegram WebApp 宿主句柄是否提供 `requestChat` 方法。
 *
 * @param webApp 宿主句柄
 * @returns 支持原生选择器时返回 `true`
 */
function isNativePickerCapableWebApp(
  webApp: Readonly<TelegramWebApp> | undefined
): webApp is NativePickerCapableWebApp {
  return webApp !== undefined && typeof webApp.requestChat === "function";
}

/**
 * 读取支持 `requestChat` 的 Telegram WebApp 宿主句柄；当前客户端不支持时按当前语言弹出警告提示并返回 `null`。
 *
 * @returns 可调用 `requestChat` 的宿主句柄；不支持时返回 `null`
 */
export function resolveNativePickerWebApp(): NativePickerCapableWebApp | null {
  const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
  if (!isNativePickerCapableWebApp(webApp)) {
    const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
      useMiniAppStore.getState().language
    );
    useMiniAppStore
      .getState()
      .notify(t.identities.pickerUnsupportedHint, "warning");
    return null;
  }
  return webApp;
}

/**
 * 创建与单个页面仓库生命周期绑定的 Telegram 原生选择器轮询控制器。
 *
 * @returns 原生选择器轮询控制器
 */
export function createMiniAppNativePickerController(): MiniAppNativePickerController {
  let activeController: AbortController | null = null;
  let sessionEpoch: number = 0;

  const abortActivePoll = (): void => {
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
  };

  const pollSession = async (
    requestId: number,
    timeoutTone: MiniAppToastTone | undefined,
    onResult: (
      outcome: Readonly<MiniAppPickerResultEvent>
    ) => Promise<void> | void
  ): Promise<void> => {
    abortActivePoll();
    const controller: AbortController = new AbortController();
    activeController = controller;
    let outcome: Readonly<MiniAppPickerResultEvent> | "timeout" | "aborted";
    try {
      outcome = await waitForMiniAppPickerResult(requestId, controller.signal);
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }
      useMiniAppStore.getState().notify(errorMessage(error), "warning", error);
      return;
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
    if (outcome === "aborted" || controller.signal.aborted) {
      return;
    }
    if (outcome === "timeout") {
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        useMiniAppStore.getState().language
      );
      useMiniAppStore
        .getState()
        .notify(t.identities.pickerTimeoutToast, timeoutTone);
      return;
    }
    await onResult(outcome);
  };

  return {
    captureEpoch: (): number => sessionEpoch,

    launch: ({
      webApp,
      preparedButtonId,
      requestId,
      expectedEpoch,
      timeoutTone,
      onResult,
    }: Readonly<LaunchMiniAppNativePickerOptions>): void => {
      if (expectedEpoch !== undefined && expectedEpoch !== sessionEpoch) {
        return;
      }
      abortActivePoll();
      sessionEpoch += 1;
      const launchEpoch: number = sessionEpoch;
      webApp.requestChat(preparedButtonId, (accepted: boolean): void => {
        if (launchEpoch !== sessionEpoch) {
          return;
        }
        const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
          useMiniAppStore.getState().language
        );
        if (!accepted) {
          useMiniAppStore.getState().notify(t.identities.pickerCancelledToast);
          return;
        }
        useMiniAppStore.getState().notify(t.identities.pickerWaitingToast);
        void pollSession(requestId, timeoutTone, onResult);
      });
    },

    cancel: (): void => {
      sessionEpoch += 1;
      abortActivePoll();
    },
  };
}
