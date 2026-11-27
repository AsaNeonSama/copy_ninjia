import { mutateMiniAppChatTargets } from "../api/chatTargets";
import { MINI_APP_SIGNED_INTEGER_PATTERN } from "../consts/miniApp/auth";
import { getMiniAppTranslations } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppChatDeleteTargetItem,
  MiniAppChatDetail,
  MiniAppChatTargetsMutationRequest,
  MiniAppChatTargetsMutationResult,
  MiniAppChatTargetsView,
  MiniAppChatTranslateTargetItem,
} from "../types/miniApp/chats";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";
import type { MiniAppChatsStoreState } from "./chats";

/** 构造受管群「目标与问答」增删变更子动作所需的仓库读写句柄。 */
export interface CreateChatTargetsMutationsOptions {
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
}

/** 受管群「目标与问答」增删变更动作集合。 */
export type MiniAppChatTargetsMutationActions = Pick<
  MiniAppChatsStoreState,
  | "submitQaPair"
  | "removeQaPair"
  | "submitDeleteTarget"
  | "removeDeleteTarget"
  | "submitTranslateTarget"
  | "removeTranslateTarget"
>;

/**
 * 校验群目标（删发言目标、追着翻目标）的纯数字 ID 输入是否合法。
 * 仅允许正安全整数用户 ID，或以 `-100` 开头且后缀为无前导零正安全整数的频道负安全整数 ID；
 * 拒绝 `@username`、裸用户名、普通负数（如 `"-500"`）、`"-100"`、`"-1000"` 及带前导零的写法（如 `"0123"`）。
 *
 * @param trimmed 已去首尾空白的目标输入字符串
 * @returns 为合法的用户正整数 ID 或 `-100...` 频道负整数 ID 时返回 `true`
 */
export function isValidChatTargetNumericInput(trimmed: string): boolean {
  if (!MINI_APP_SIGNED_INTEGER_PATTERN.test(trimmed)) {
    return false;
  }
  const id: number = Number(trimmed);
  if (!Number.isSafeInteger(id) || id === 0 || String(id) !== trimmed) {
    return false;
  }
  if (id > 0) {
    return true;
  }
  return (
    trimmed.startsWith("-100") &&
    trimmed.length > 4 &&
    !trimmed.startsWith("-1000")
  );
}

/**
 * 创建受管群「目标与问答」弹窗中的问答对、追着删目标与追着翻目标增删提交动作集合。
 *
 * @param options 仓库读写句柄与目标请求序号控制函数
 * @returns 绑定到当前受管群仓库的目标增删动作集合
 */
export function createChatTargetsMutations({
  set,
  get,
  applyMutationDetail,
  nextTargetsReqSeq,
  currentTargetsReqSeq,
}: CreateChatTargetsMutationsOptions): MiniAppChatTargetsMutationActions {
  const executeTargetsMutation = async (
    payload: Readonly<MiniAppChatTargetsMutationRequest>,
    onSuccess?: () => void
  ): Promise<void> => {
    const { selectedChatId, mutatingTargets }: MiniAppChatsStoreState = get();
    if (selectedChatId === null || mutatingTargets) return;
    const reqId: number = nextTargetsReqSeq();
    const startedAt: number = Date.now();
    set({ mutatingTargets: true });
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
        if (result.ok && !isNoOpWarning && onSuccess !== undefined) {
          onSuccess();
        }
        if (result.detail !== null) {
          applyMutationDetail(result.detail);
        }
        set({
          ...(result.targets !== null ? { chatTargets: result.targets } : {}),
          mutatingTargets: false,
          ...(reqId === currentTargetsReqSeq() ? { loadingTargets: false } : {}),
        });
      } else if (reqId === currentTargetsReqSeq()) {
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

  const removeChatTarget = async (
    kind: "delete" | "translate",
    targetId: number
  ): Promise<void> => {
    if (get().selectedChatId === null || get().mutatingTargets) return;
    const targets: Readonly<MiniAppChatTargetsView> | null = get().chatTargets;
    const targetItem:
      | Readonly<MiniAppChatDeleteTargetItem | MiniAppChatTranslateTargetItem>
      | undefined = (
        kind === "delete"
          ? targets?.deleteMessageTargets
          : targets?.translateTargets
      )?.find(
        (
          item: Readonly<MiniAppChatDeleteTargetItem | MiniAppChatTranslateTargetItem>
        ): boolean => item.id === targetId
      );
    const displayName: string = targetItem?.displayName ?? `ID ${targetId}`;
    const app: MiniAppUiStoreState = useMiniAppStore.getState();
    const chatsText: Readonly<MiniAppTranslations>["chats"] =
      getMiniAppTranslations(app.language).chats;
    const confirmText: string =
      kind === "delete"
        ? chatsText.confirmRemoveDeleteTarget(displayName, targetId)
        : chatsText.confirmRemoveTranslateTarget(displayName, targetId);
    if (!(await app.requestConfirm(confirmText, "danger"))) {
      return;
    }
    if (get().selectedChatId === null || get().mutatingTargets) return;
    await executeTargetsMutation({
      action: kind === "delete" ? "removeDeleteTarget" : "removeTranslateTarget",
      id: targetId,
    });
  };

  return {
    submitQaPair: async (): Promise<void> => {
      const { selectedChatId, mutatingTargets, qaQuestionInput, qaAnswerInput }: MiniAppChatsStoreState = get();
      if (selectedChatId === null || mutatingTargets) return;
      await executeTargetsMutation(
        {
          action: "setQa",
          q: qaQuestionInput,
          a: qaAnswerInput,
        },
        (): void => {
          set({
            qaEditorOpen: false,
            qaQuestionInput: "",
            qaAnswerInput: "",
            qaEditSourceQuestion: null,
          });
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
      if (get().selectedChatId === null || get().mutatingTargets) return;
      await executeTargetsMutation({
        action: "removeQa",
        q,
      });
    },

    submitDeleteTarget: async (): Promise<void> => {
      const { selectedChatId, mutatingTargets, deleteTargetInput }: MiniAppChatsStoreState = get();
      if (selectedChatId === null || mutatingTargets) return;
      const trimmed: string = deleteTargetInput.trim();
      if (trimmed.length === 0) {
        useMiniAppStore.getState().notify("TARGET_REQUIRED", "warning");
        return;
      }
      if (!isValidChatTargetNumericInput(trimmed)) {
        useMiniAppStore.getState().notify("TARGET_INVALID", "warning");
        return;
      }
      await executeTargetsMutation(
        {
          action: "addDeleteTarget",
          target: trimmed,
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

    removeDeleteTarget: (targetId: number): Promise<void> =>
      removeChatTarget("delete", targetId),

    submitTranslateTarget: async (): Promise<void> => {
      const {
        selectedChatId,
        mutatingTargets,
        translateTargetInput,
        translateLanguageInput,
      }: MiniAppChatsStoreState = get();
      if (selectedChatId === null || mutatingTargets) return;
      const trimmed: string = translateTargetInput.trim();
      if (trimmed.length === 0) {
        useMiniAppStore.getState().notify("TARGET_REQUIRED", "warning");
        return;
      }
      if (!isValidChatTargetNumericInput(trimmed)) {
        useMiniAppStore.getState().notify("TARGET_INVALID", "warning");
        return;
      }
      await executeTargetsMutation(
        {
          action: "addTranslateTarget",
          target: trimmed,
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

    removeTranslateTarget: (targetId: number): Promise<void> =>
      removeChatTarget("translate", targetId),
  };
}
