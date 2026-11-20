import { fetchMiniAppChatTargets } from "../api/chatTargets";
import { requestMiniAppPreparedPicker } from "../api/pickerPrepare";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppChatDetail,
  MiniAppChatTargetKind,
  MiniAppChatTargetsView,
  MiniAppTranslateLanguage,
} from "../types/miniApp/chats";
import type {
  MiniAppIdentityAddMode,
  MiniAppPickerResultEvent,
  MiniAppPickerSubjectKind,
  PrepareMiniAppPickerResult,
} from "../types/miniApp/identities";
import { notifyMiniAppIfAuthError, useMiniAppStore } from "./app";
import type { MiniAppChatsStoreState } from "./chats";
import { createChatTargetsMutations } from "./chatTargetsMutations";
import { resolveNativePickerWebApp } from "./nativePicker";
import type {
  MiniAppNativePickerController,
  NativePickerCapableWebApp,
} from "./nativePicker";

export { isValidChatTargetNumericInput } from "./chatTargetsMutations";

/** 构造受管群「目标与问答」子动作所需的仓库读写句柄。 */
export interface CreateChatTargetsActionsOptions {
  /** 更新 `MiniAppChatsStoreState` 的局部字段。 */
  readonly set: (partial: Partial<MiniAppChatsStoreState>) => void;
  /** 读取当前 `MiniAppChatsStoreState` 快照。 */
  readonly get: () => MiniAppChatsStoreState;
  /** 写入变更接口回传的最新群详情并推进详情请求序号，作废更早发出的在途详情读取。 */
  readonly applyMutationDetail: (detail: MiniAppChatDetail) => void;
  /** 递增并返回下一次目标请求序号（用于丢弃过期响应）。 */
  readonly nextTargetsReqSeq: () => number;
  /** 读取当前最新的目标请求序号。 */
  readonly currentTargetsReqSeq: () => number;
  /** 受管群页面共用的 Telegram 原生选择器轮询生命周期控制器。 */
  readonly pickerController: MiniAppNativePickerController;
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
  applyMutationDetail,
  nextTargetsReqSeq,
  currentTargetsReqSeq,
  pickerController,
}: CreateChatTargetsActionsOptions): MiniAppChatTargetsActions {
  const handleTargetPickerResult = async (
    outcome: Readonly<MiniAppPickerResultEvent>,
    chatId: number
  ): Promise<void> => {
    if (get().selectedChatId === chatId) {
      await get().loadChatTargets(get().chatTargets?.chatId === chatId);
      void get().loadDetail(chatId);
    }
    useMiniAppStore.getState().notify(
      outcome.summary,
      outcome.addedIds.length > 0 ? "info" : "warning",
      outcome
    );
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
    const webApp: NativePickerCapableWebApp | null = resolveNativePickerWebApp();
    if (webApp === null) {
      return;
    }
    const prepareEpoch: number = pickerController.captureEpoch();
    set({ mutatingTargets: true, preparingPickerMode: subjectKind });
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
      pickerController.launch({
        webApp,
        preparedButtonId: prepared.preparedButtonId,
        requestId: prepared.requestId,
        expectedEpoch: prepareEpoch,
        timeoutTone: "warning",
        onResult: (outcome: Readonly<MiniAppPickerResultEvent>): Promise<void> =>
          handleTargetPickerResult(outcome, selectedChatId),
      });
    } catch (error: unknown) {
      useMiniAppStore.getState().notify(
        errorMessage(error),
        "warning",
        error
      );
    } finally {
      set({ mutatingTargets: false, preparingPickerMode: null });
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
      const { selectedChatId, chatTargets }: MiniAppChatsStoreState = get();
      const hasCurrentChatTargets: boolean =
        selectedChatId !== null &&
        chatTargets !== null &&
        chatTargets.chatId === selectedChatId;
      set({
        targetsMenuOpen: false,
        activeTargetsModal: kind,
        preparingPickerMode: null,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
      void get().loadChatTargets(hasCurrentChatTargets);
    },

    switchTargetsModalTab: (kind: MiniAppChatTargetKind): void => {
      set({
        activeTargetsModal: kind,
        preparingPickerMode: null,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
    },

    closeTargetsModal: (): void => {
      set({
        activeTargetsModal: null,
        preparingPickerMode: null,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        translateLangMenuOpen: false,
      });
    },

    loadChatTargets: async (silent: boolean = false): Promise<void> => {
      const chatId: number | null = get().selectedChatId;
      if (chatId === null) return;
      const reqId: number = nextTargetsReqSeq();
      const startedAt: number = Date.now();
      if (!silent) {
        set({ loadingTargets: true });
      }
      try {
        const targets: MiniAppChatTargetsView =
          await fetchMiniAppChatTargets(chatId);
        if (!silent) {
          await waitMinimumLoadingDuration(startedAt);
        }
        if (reqId !== currentTargetsReqSeq() || get().selectedChatId !== chatId) {
          return;
        }
        set({ chatTargets: targets });
      } catch (error: unknown) {
        if (!silent) {
          await waitMinimumLoadingDuration(startedAt);
        }
        if (reqId !== currentTargetsReqSeq() || get().selectedChatId !== chatId) {
          notifyMiniAppIfAuthError(error);
          return;
        }
        const message: string = errorMessage(error);
        useMiniAppStore.getState().notify(message, "info", error);
      } finally {
        if (reqId === currentTargetsReqSeq() && get().loadingTargets) {
          set({ loadingTargets: false });
        }
      }
    },

    openQaEditor: (): void => {
      set({ qaEditorOpen: true });
    },

    closeQaEditor: (): void => {
      set({
        qaEditorOpen: false,
        qaQuestionInput: "",
        qaAnswerInput: "",
        qaEditSourceQuestion: null,
      });
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
        preparingPickerMode: null,
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

    setQaQuestionInput: (value: string): void => {
      set({ qaQuestionInput: value });
    },

    setQaAnswerInput: (value: string): void => {
      set({ qaAnswerInput: value });
    },

    fillQaPairForEdit: (q: string, a: string): void => {
      set({
        qaEditorOpen: true,
        qaQuestionInput: q,
        qaAnswerInput: a,
        qaEditSourceQuestion: q,
      });
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

    ...createChatTargetsMutations({
      set,
      get,
      applyMutationDetail,
      nextTargetsReqSeq,
      currentTargetsReqSeq,
    }),
  };
}
