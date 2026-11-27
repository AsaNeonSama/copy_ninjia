import {
  classifyMiniAppAuthError,
  isSuppressedStaleMiniAppAuthError,
} from "../api/authError";
import type { MiniAppAuthErrorAction } from "../api/authError";
import { loginMiniAppWithPassword } from "../api/authLogin";
import { logoutMiniAppSession } from "../api/authLogout";
import { precheckMiniAppAccess } from "../api/authPrecheck";
import {
  extractServerNoticeParams,
  getMiniAppTranslations,
} from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import {
  clearMiniAppSessionToken,
  readMiniAppSessionExpiresAt,
  readMiniAppSessionToken,
} from "../libs/credentials";
import { buildFallbackDiagnostics } from "../libs/diagnostics";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppAccessDiagnostics,
  MiniAppPrecheckResult,
} from "../types/miniApp/auth";
import type {
  MiniAppGateState,
  MiniAppToastTone,
  MiniAppUiStoreState,
} from "./app";

/** 构造根仓库鉴权门禁与 Toast 通知子动作所需的读写句柄与计时器控制回调。 */
export interface CreateAppGateActionsOptions {
  /** 更新根仓库局部状态（支持对象或状态回调形式）。 */
  readonly set: (
    partial:
      | Partial<MiniAppUiStoreState>
      | ((state: MiniAppUiStoreState) => Partial<MiniAppUiStoreState>)
  ) => void;
  /** 读取根仓库当前状态快照。 */
  readonly get: () => MiniAppUiStoreState;
  /** 清除 Toast 自动消失计时器。 */
  readonly clearToastTimer: () => void;
  /** 重新排期 Toast 自动消失计时器。 */
  readonly scheduleToastDismiss: () => void;
  /** 清除会话到期自动锁定计时器。 */
  readonly clearSessionTimer: () => void;
  /** 按本机会话到期时间戳排期会话自动锁定计时器。 */
  readonly scheduleSessionExpiry: (expiresAt: number) => void;
  /** 清理会话计时器、清除本地凭据并按取消结算待确认弹窗。 */
  readonly clearActiveSessionState: () => void;
}

/** 根仓库的鉴权门禁、通知归类、会话锁定与计时器清理动作集合。 */
export type MiniAppGateActions = Pick<
  MiniAppUiStoreState,
  | "notify"
  | "lockSession"
  | "logout"
  | "runAccessPrecheck"
  | "submitCredential"
  | "clearTimers"
>;

/**
 * 创建根仓库的鉴权门禁（预检、密码/TOTP 登录、会话锁定、注销）与全局通知归类动作集合。
 *
 * @param options 根仓库读写句柄与计时器控制回调
 * @returns 绑定到根仓库的门禁与通知动作集合
 */
export function createAppGateActions({
  set,
  get,
  clearToastTimer,
  scheduleToastDismiss,
  clearSessionTimer,
  scheduleSessionExpiry,
  clearActiveSessionState,
}: CreateAppGateActionsOptions): MiniAppGateActions {
  let accessRecheckPending: boolean = false;

  const CLOSED_GATE_UI_RESET: Readonly<
    Pick<
      MiniAppUiStoreState,
      | "langMenuOpen"
      | "sidebarOpen"
      | "statusReady"
      | "sessionExpiresAt"
      | "confirmModal"
      | "passwordInput"
    >
  > = {
    langMenuOpen: false,
    sidebarOpen: false,
    statusReady: false,
    sessionExpiresAt: 0,
    confirmModal: null,
    passwordInput: "",
  };

  return {
    notify: (
      message: string,
      tone: MiniAppToastTone = "info",
      metaSource?: unknown
    ): void => {
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
        get().language
      );
      const localized: string = t.serverNotice(
        message,
        extractServerNoticeParams(metaSource)
      );
      const authAction: MiniAppAuthErrorAction | null =
        classifyMiniAppAuthError(message, metaSource);
      if (authAction === "accessDenied") {
        accessRecheckPending = true;
        clearToastTimer();
        clearActiveSessionState();
        set({
          ...CLOSED_GATE_UI_RESET,
          gateState: "checking",
        });
        return;
      }
      if (authAction === "reauth") {
        const currentGate: MiniAppGateState = get().gateState;
        if (
          currentGate === "denied" ||
          (currentGate === "checking" && accessRecheckPending)
        ) {
          clearActiveSessionState();
          return;
        }
        get().lockSession(localized);
        return;
      }
      if (isSuppressedStaleMiniAppAuthError(message, metaSource)) {
        return;
      }
      get().showToast(localized, tone);
      if (localized.length > 0) {
        scheduleToastDismiss();
      } else {
        clearToastTimer();
      }
    },

    lockSession: (reason: string): void => {
      accessRecheckPending = false;
      clearActiveSessionState();
      const localizedReason: string = getMiniAppTranslations(
        get().language
      ).serverNotice(reason);
      set((state: MiniAppUiStoreState): Partial<MiniAppUiStoreState> => ({
        ...CLOSED_GATE_UI_RESET,
        passwordError: localizedReason,
        gateState: "password",
        toastText: localizedReason,
        toastTone: "warning",
        toastSeq:
          localizedReason.length > 0 ? state.toastSeq + 1 : state.toastSeq,
      }));
      if (localizedReason.length > 0) {
        scheduleToastDismiss();
      } else {
        clearToastTimer();
      }
    },

    logout: (reason: string): void => {
      const sessionToken: string = readMiniAppSessionToken();
      if (sessionToken.length > 0) {
        void logoutMiniAppSession(sessionToken);
      }
      get().lockSession(reason);
    },

    runAccessPrecheck: async (): Promise<void> => {
      try {
        const result: MiniAppPrecheckResult = await precheckMiniAppAccess();
        accessRecheckPending = false;
        if (!result.ok) {
          set({ deniedDiag: result.diagnostics, gateState: "denied" });
          return;
        }
        set({
          authMode: result.authMode ?? (result.totpEnabled === true ? "totp" : "password"),
          passwordError: null,
        });
        if (
          result.sessionValid === true &&
          typeof result.sessionExpiresAt === "number" &&
          result.sessionExpiresAt > Date.now() &&
          readMiniAppSessionToken().length > 0
        ) {
          scheduleSessionExpiry(result.sessionExpiresAt);
          set({ sessionExpiresAt: result.sessionExpiresAt, gateState: "unlocked" });
          return;
        }
        set({ gateState: "password" });
      } catch (error: unknown) {
        accessRecheckPending = false;
        clearMiniAppSessionToken();
        const message: string = errorMessage(error);
        set({ deniedDiag: buildFallbackDiagnostics(message), gateState: "denied" });
      }
    },

    submitCredential: async (): Promise<void> => {
      const { authMode, passwordInput, passwordBusy, language }: MiniAppUiStoreState = get();
      if (passwordBusy) return;
      const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(language);
      const trimmed: string = passwordInput.trim();
      if (authMode === "totp") {
        if (!/^\d{6}$/u.test(trimmed)) {
          set({ passwordError: t.gate.totpEmptyHint });
          return;
        }
      } else if (trimmed.length === 0) {
        set({ passwordError: t.gate.passwordEmptyHint });
        return;
      }
      const startedAt: number = Date.now();
      set({ passwordBusy: true, passwordError: null, langMenuOpen: false });
      try {
        await loginMiniAppWithPassword(trimmed, authMode);
        await waitMinimumLoadingDuration(startedAt);
        const localExpiresAt: number = readMiniAppSessionExpiresAt();
        scheduleSessionExpiry(localExpiresAt);
        set({
          sessionExpiresAt: localExpiresAt,
          statusReady: false,
          passwordInput: "",
          gateState: "unlocked",
        });
        get().notify(t.gate.unlockedToast);
      } catch (error: unknown) {
        const message: string = errorMessage(error);
        const strippedMessage: string = message
          .replace(/^\[[A-Z0-9_]+\]\s*/u, "")
          .trim();
        if (classifyMiniAppAuthError(message, error) === "accessDenied") {
          let deniedDiag: Readonly<MiniAppAccessDiagnostics>;
          try {
            const deniedCheck: MiniAppPrecheckResult =
              await precheckMiniAppAccess();
            deniedDiag = deniedCheck.ok
              ? buildFallbackDiagnostics(strippedMessage)
              : deniedCheck.diagnostics;
          } catch (_precheckError: unknown) {
            deniedDiag = buildFallbackDiagnostics(strippedMessage);
          }
          await waitMinimumLoadingDuration(startedAt);
          accessRecheckPending = false;
          clearToastTimer();
          clearActiveSessionState();
          set({
            ...CLOSED_GATE_UI_RESET,
            deniedDiag,
            gateState: "denied",
          });
          return;
        }
        await waitMinimumLoadingDuration(startedAt);
        const causeRecord: Record<string, unknown> = asPayloadRecord(
          error instanceof Error ? error.cause : undefined
        );
        const noticeParams: ReturnType<typeof extractServerNoticeParams> =
          extractServerNoticeParams(error);
        const rawCode: string =
          typeof causeRecord.code === "string" ? causeRecord.code.trim() : "";
        const localizedByCode: string =
          rawCode.length > 0 ? t.serverNotice(rawCode, noticeParams) : "";
        set({
          passwordError:
            rawCode.length > 0 && localizedByCode !== rawCode
              ? localizedByCode
              : t.serverNotice(strippedMessage, noticeParams),
        });
      } finally {
        set({ passwordBusy: false });
      }
    },

    clearTimers: (): void => {
      accessRecheckPending = false;
      clearToastTimer();
      clearSessionTimer();
    },
  };
}
