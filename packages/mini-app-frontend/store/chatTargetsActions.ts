import {
  fetchMiniAppChatTargets,
  mutateMiniAppChatTargets,
} from "../api/chatTargets";
import { requestMiniAppPreparedPicker } from "../api/pickerPrepare";
import { pollMiniAppPickerResult } from "../api/pickerResult";
import {
  MINI_APP_PICKER_POLL_INTERVAL_MS,
  MINI_APP_PICKER_POLL_MAX_ATTEMPTS,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import { getTelegramWebApp } from "../libs/telegram";
import type {
  MiniAppChatDeleteTargetItem,
  MiniAppChatTargetKind,
  MiniAppChatTargetsMutationRequest,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
  MiniAppChatTranslateTargetItem,
  MiniAppIdentityAddMode,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  MiniAppTranslateLanguage,
  PrepareMiniAppPickerResult,
  TelegramWebApp,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";
import type { MiniAppChatsStoreState } from "./chats";

/** 构造受管群「目标与问答」子动作所需的仓库读写句柄。 */
export interface CreateChatTargetsActionsOptions {
  /** 更新 `MiniAppChatsStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppChatsStoreState>) => void;
  /** 读取当前 `MiniAppChatsStoreState` 快照。 */
  readonly get: () => MiniAppChatsStoreState;
  /** 递增并返回下一次目标请求序号（用于丢弃过期响应）。 */
  readonly nextTargetsReqSeq: () => number;
  /** 读取当前最新的目标请求序号。 */
  readonly currentTargetsReqSeq: () => number;
}

/** 受管群「目标与问答」弹窗相关的动作集合。 */
export type MiniAppChatTargetsActions = Pick<
  MiniAppChatsStoreState,
  | "toggleTargetsMenu"
  | "closeTargetsMenu"
  | "openTargetsModal"
  | "switchTargetsModalTab"
  | "closeTargetsModal"
  | "loadChatTargets"
  | "openQaEditor"
  | "closeQaEditor"
  | "openTargetAddMenu"
  | "closeTargetAddMenu"
  | "selectTargetAddMode"
  | "closeTargetIdForm"
  | "setQaQuestionInput"
  | "setQaAnswerInput"
  | "fillQaPairForEdit"
  | "setDeleteTargetInput"
  | "setTranslateTargetInput"
  | "setTranslateLanguageInput"
  | "toggleTranslateLangMenu"
  | "closeTranslateLangMenu"
  | "submitQaPair"
  | "removeQaPair"
  | "submitDeleteTarget"
  | "removeDeleteTarget"
  | "submitTranslateTarget"
  | "removeTranslateTarget"
>;

/**
 * 创建受管群详情中「目标与问答」弹窗（问答对、追着删目标、追着翻目标）的状态动作集合。
 *
 * @param options 仓库读写句柄与目标请求序号控制函数
 * @returns 绑定到当前受管群仓库的目标管理动作集合
 */
export function createChatTargetsActions({
  set,
  get,
  nextTargetsReqSeq,
  currentTargetsReqSeq,
}: CreateChatTargetsActionsOptions): MiniAppChatTargetsActions {
  const executeTargetsMutation = async (
    payload: Readonly<MiniAppChatTargetsMutationRequest>,
    onSuccess?: () => void
  ): Promise<void> => {
    const { selectedChatId, mutatingTargets }: MiniAppChatsStoreState = get();
    if (selectedChatId === null || mutatingTargets) return;
    const reqId: number = nextTargetsReqSeq();
    const startedAt: number = Date.now();
    set({ mutatingTargets: true, loadingTargets: true });
    try {
      const result: MiniAppChatTargetsMutationResult =
        await mutateMiniAppChatTargets(selectedChatId, payload);
      await waitMinimumLoadingDuration(startedAt);
      const isNoOpWarning: boolean =
        result.message === "DELETE_TARGET_ALREADY_EXISTS" ||
        result.message === "TRANSLATE_TARGET_ALREADY_EXISTS" ||
        result.message === "QA_NOT_FOUND" ||
        result.message === "DELETE_TARGET_NOT_FOUND" ||
        result.message === "TRANSLATE_TARGET_NOT_FOUND";
      if (get().selectedChatId === selectedChatId) {
        if (result.detail !== null) {
          set({ chatDetail: result.detail });
        }
        if (result.targets !== null) {
          set({ chatTargets: result.targets });
        }
        if (result.ok && !isNoOpWarning && onSuccess !== undefined) {
          onSuccess();
        }
      }
      if (reqId === currentTargetsReqSeq()) {
        set({ mutatingTargets: false, loadingTargets: false });
      } else {
        set({ mutatingTargets: false });
      }
      useMiniAppStore.getState().notify(
        result.message,
        result.ok && !isNoOpWarning ? "info" : "warning",
        result
      );
    } catch (error: unknown) {
      await waitMinimumLoadingDuration(startedAt);
      if (reqId === currentTargetsReqSeq()) {
        set({ mutatingTargets: false, loadingTargets: false });
      } else {
        set({ mutatingTargets: false });
      }
      const message: string = errorMessage(error);
      useMiniAppStore.getState().notify(message, "warning", error);
    }
  };

  const pollTargetPickerSession = async (
    requestId: number,
    chatId: number
  ): Promise<void> => {
    for (
      let attempt: number = 0;
      attempt < MINI_APP_PICKER_POLL_MAX_ATTEMPTS;
      attempt += 1
    ) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, MINI_APP_PICKER_POLL_INTERVAL_MS);
      });
      try {
        const result: Readonly<MiniAppPickerResultEvent> | null =
          await pollMiniAppPickerResult(requestId);
        if (result !== null) {
          if (get().selectedChatId === chatId) {
            await get().loadChatTargets();
            void get().loadDetail(chatId);
          }
          useMiniAppStore.getState().notify(
            result.summary,
            result.addedIds.length > 0 ? "info" : "warning",
            result
          );
          return;
        }
      } catch (_error: unknown) {
        return;
      }
    }
    const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
      useMiniAppStore.getState().language
    );
    useMiniAppStore.getState().notify(t.identities.pickerTimeoutToast, "warning");
  };

  const checkActiveTargetModalPrerequisite = (): string | null => {
    const {
      activeTargetsModal,
      chatDetail,
      chatTargets,
    }: MiniAppChatsStoreState = get();
    if (
      activeTargetsModal === "deleteMessage" &&
      chatDetail?.botPermissions !== null &&
      chatDetail?.botPermissions?.canDeleteMessages === false
    ) {
      return "DELETE_TARGET_MISSING_BOT_PERMISSION";
    }
    if (
      activeTargetsModal === "translate" &&
      (chatTargets !== null
        ? !chatTargets.isTranslationEnabled
        : chatDetail?.features.translation === false)
    ) {
      return "TRANSLATE_FEATURE_DISABLED";
    }
    return null;
  };

  const openTargetPicker = async (
    subjectKind: MiniAppPickerSubjectKind
  ): Promise<void> => {
    const {
      selectedChatId,
      activeTargetsModal,
      translateLanguageInput,
      mutatingTargets,
    }: MiniAppChatsStoreState = get();
    if (
      selectedChatId === null ||
      mutatingTargets ||
      (activeTargetsModal !== "deleteMessage" &&
        activeTargetsModal !== "translate")
    ) {
      return;
    }
    const prereqCode: string | null = checkActiveTargetModalPrerequisite();
    if (prereqCode !== null) {
      useMiniAppStore.getState().notify(prereqCode, "warning");
      return;
    }
    const t: Readonly<MiniAppTranslations> = getMiniAppTranslations(
      useMiniAppStore.getState().language
    );
    const webApp: Readonly<TelegramWebApp> | undefined = getTelegramWebApp();
    if (typeof webApp?.requestChat !== "function") {
      useMiniAppStore.getState().notify(
        t.identities.pickerUnsupportedHint,
        "warning"
      );
      return;
    }
    set({ mutatingTargets: true });
    try {
      const prepared: Extract<
        PrepareMiniAppPickerResult,
        { readonly ok: true }
      > = await requestMiniAppPreparedPicker(
        activeTargetsModal,
        subjectKind,
        {
          chatId: selectedChatId,
          ...(activeTargetsModal === "translate"
            ? { language: translateLanguageInput }
            : {}),
        }
      );
      set({ targetAddMenuOpen: false, targetIdFormOpen: false });
      webApp.requestChat(
        prepared.preparedButtonId,
        (accepted: boolean): void => {
          const nextT: Readonly<MiniAppTranslations> = getMiniAppTranslations(
            useMiniAppStore.getState().language
          );
          if (!accepted) {
            useMiniAppStore.getState().notify(
              nextT.identities.pickerCancelledToast
            );
            return;
          }
          useMiniAppStore.getState().notify(
            nextT.identities.pickerWaitingToast
          );
          void pollTargetPickerSession(prepared.requestId, selectedChatId);
        }
      );
    } catch (error: unknown) {
      useMiniAppStore.getState().notify(
        errorMessage(error),
        "warning",
        error
      );
    } finally {
      set({ mutatingTargets: false });
    }
  };

  return {
    toggleTargetsMenu: (): void => {
      set({ targetsMenuOpen: !get().targetsMenuOpen });
    },

    closeTargetsMenu: (): void => {
      if (get().targetsMenuOpen) {
        set({ targetsMenuOpen: false });
      }
    },

    openTargetsModal: (kind: MiniAppChatTargetKind): void => {
      set({
        targetsMenuOpen: false,
        activeTargetsModal: kind,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
      void get().loadChatTargets();
    },

    switchTargetsModalTab: (kind: MiniAppChatTargetKind): void => {
      set({
        activeTargetsModal: kind,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
    },

    closeTargetsModal: (): void => {
      set({
        activeTargetsModal: null,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
    },

    loadChatTargets: async (): Promise<void> => {
      const chatId: number | null = get().selectedChatId;
      if (chatId === null) return;
      const reqId: number = nextTargetsReqSeq();
      const startedAt: number = Date.now();
      set({ loadingTargets: true });
      try {
        const targets: MiniAppChatTargetsView =
          await fetchMiniAppChatTargets(chatId);
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== currentTargetsReqSeq() || get().selectedChatId !== chatId) {
          return;
        }
        set({ chatTargets: targets });
      } catch (error: unknown) {
        await waitMinimumLoadingDuration(startedAt);
        if (reqId !== currentTargetsReqSeq() || get().selectedChatId !== chatId) {
          return;
        }
        const message: string = errorMessage(error);
        useMiniAppStore.getState().notify(message, "info", error);
      } finally {
        if (reqId === currentTargetsReqSeq()) {
          set({ loadingTargets: false });
        }
      }
    },

    openQaEditor: (): void => {
      set({ qaEditorOpen: true });
    },

    closeQaEditor: (): void => {
      set({ qaEditorOpen: false, qaQuestionInput: "", qaAnswerInput: "" });
    },

    openTargetAddMenu: (): void => {
      const prereqCode: string | null = checkActiveTargetModalPrerequisite();
      if (prereqCode !== null) {
        useMiniAppStore.getState().notify(prereqCode, "warning");
      }
      set({ targetAddMenuOpen: true, translateLangMenuOpen: false });
    },

    closeTargetAddMenu: (): void => {
      set({
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
    },

    selectTargetAddMode: (mode: MiniAppIdentityAddMode): void => {
      set({ translateLangMenuOpen: false });
      if (mode === "id") {
        set({ targetIdFormOpen: !get().targetIdFormOpen });
        return;
      }
      void openTargetPicker(mode);
    },

    closeTargetIdForm: (): void => {
      set({ targetIdFormOpen: false });
    },

    setQaQuestionInput: (value: string): void => {
      set({ qaQuestionInput: value });
    },

    setQaAnswerInput: (value: string): void => {
      set({ qaAnswerInput: value });
    },

    fillQaPairForEdit: (q: string, a: string): void => {
      set({ qaEditorOpen: true, qaQuestionInput: q, qaAnswerInput: a });
    },

    setDeleteTargetInput: (value: string): void => {
      set({ deleteTargetInput: value });
    },

    setTranslateTargetInput: (value: string): void => {
      set({ translateTargetInput: value });
    },

    setTranslateLanguageInput: (language: MiniAppTranslateLanguage): void => {
      set({ translateLanguageInput: language, translateLangMenuOpen: false });
    },

    toggleTranslateLangMenu: (): void => {
      set({ translateLangMenuOpen: !get().translateLangMenuOpen });
    },

    closeTranslateLangMenu: (): void => {
      if (get().translateLangMenuOpen) {
        set({ translateLangMenuOpen: false });
      }
    },

    submitQaPair: async (): Promise<void> => {
      const { qaQuestionInput, qaAnswerInput }: MiniAppChatsStoreState = get();
      await executeTargetsMutation(
        {
          action: "setQa",
          q: qaQuestionInput,
          a: qaAnswerInput,
        },
        (): void => {
          set({ qaEditorOpen: false, qaQuestionInput: "", qaAnswerInput: "" });
        }
      );
    },

    removeQaPair: async (q: string): Promise<void> => {
      if (get().selectedChatId === null || get().mutatingTargets) return;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      if (
        !(await app.requestConfirm(
          getMiniAppTranslations(app.language).chats.confirmDeleteQa(q),
          "danger"
        ))
      ) {
        return;
      }
      await executeTargetsMutation({
        action: "removeQa",
        q,
      });
    },

    submitDeleteTarget: async (): Promise<void> => {
      const { deleteTargetInput }: MiniAppChatsStoreState = get();
      await executeTargetsMutation(
        {
          action: "addDeleteTarget",
          target: deleteTargetInput,
        },
        (): void => {
          set({
            deleteTargetInput: "",
            targetAddMenuOpen: false,
            targetIdFormOpen: false,
          });
        }
      );
    },

    removeDeleteTarget: async (targetId: number): Promise<void> => {
      if (get().selectedChatId === null || get().mutatingTargets) return;
      const targetItem: Readonly<MiniAppChatDeleteTargetItem> | undefined =
        get().chatTargets?.deleteMessageTargets.find(
          (item: Readonly<MiniAppChatDeleteTargetItem>): boolean =>
            item.id === targetId
        );
      const displayName: string = targetItem?.displayName ?? `ID ${targetId}`;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      if (
        !(await app.requestConfirm(
          getMiniAppTranslations(app.language).chats.confirmRemoveDeleteTarget(
            displayName,
            targetId
          ),
          "danger"
        ))
      ) {
        return;
      }
      await executeTargetsMutation({
        action: "removeDeleteTarget",
        id: targetId,
      });
    },

    submitTranslateTarget: async (): Promise<void> => {
      const {
        translateTargetInput,
        translateLanguageInput,
      }: MiniAppChatsStoreState = get();
      await executeTargetsMutation(
        {
          action: "addTranslateTarget",
          target: translateTargetInput,
          language: translateLanguageInput,
        },
        (): void => {
          set({
            translateTargetInput: "",
            targetAddMenuOpen: false,
            targetIdFormOpen: false,
          });
        }
      );
    },

    removeTranslateTarget: async (targetId: number): Promise<void> => {
      if (get().selectedChatId === null || get().mutatingTargets) return;
      const targetItem: Readonly<MiniAppChatTranslateTargetItem> | undefined =
        get().chatTargets?.translateTargets.find(
          (item: Readonly<MiniAppChatTranslateTargetItem>): boolean =>
            item.id === targetId
        );
      const displayName: string = targetItem?.displayName ?? `ID ${targetId}`;
      const app: MiniAppUiStoreState = useMiniAppStore.getState();
      if (
        !(await app.requestConfirm(
          getMiniAppTranslations(app.language).chats.confirmRemoveTranslateTarget(
            displayName,
            targetId
          ),
          "danger"
        ))
      ) {
        return;
      }
      await executeTargetsMutation({
        action: "removeTranslateTarget",
        id: targetId,
      });
    },
  };
}
