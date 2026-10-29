import { createStore } from "zustand";
import type { StoreApi } from "zustand";
import { triggerMiniAppChatBatchKick } from "../api/chatBatchKick";
import { fetchMiniAppChatDetail } from "../api/chatDetail";
import { toggleMiniAppChatFeature } from "../api/chatFeature";
import { fetchMiniAppChats } from "../api/chats";
import {
  MINI_APP_BATCH_KICK_DEFAULT_HOURS,
  MINI_APP_BATCH_KICK_MAX_HOURS,
  MINI_APP_BATCH_KICK_MIN_HOURS,
  MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS,
  MINI_APP_CHATS_DEFAULT_PAGE_SIZE,
} from "../consts/miniApp";
import { getMiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { waitMinimumLoadingDuration } from "../libs/loading";
import type {
  MiniAppBatchKickResult,
  MiniAppChatDetail,
  MiniAppChatSummary,
  MiniAppChatTargetKind,
  MiniAppChatTargetsView,
  MiniAppFeatureKey,
  MiniAppFeatureToggleResult,
  MiniAppIdentityAddMode,
  MiniAppTranslateLanguage,
} from "../types/miniApp";
import { useMiniAppStore } from "./app";
import type { MiniAppUiStoreState } from "./app";
import { createChatTargetsActions } from "./chatTargetsActions";

/** `ChatsPage` 受管群列表与群详情的状态与动作接口。 */
export interface MiniAppChatsStoreState {
  /** 已启用 `/init` 的受管群摘要列表。 */
  readonly chats: readonly Readonly<MiniAppChatSummary>[];
  /** 是否正在加载群列表。 */
  readonly loadingList: boolean;
  /** 当前打开详情的群 ID（列表视图时为 `null`）。 */
  readonly selectedChatId: number | null;
  /** 当前打开的群详情快照。 */
  readonly chatDetail: MiniAppChatDetail | null;
  /** 是否正在加载群详情。 */
  readonly loadingDetail: boolean;
  /** 是否展开群详情顶部的「Bot 拥有以下 N 项管理员权限」标签列表（默认折叠为 `false`）。 */
  readonly botPermsExpanded: boolean;
  /** 正在切换的功能开关键（无切换时为 `null`）。 */
  readonly togglingFeature: MiniAppFeatureKey | null;
  /** 当前选中的 `/batch_kick` 回溯小时数（`1..24`）。 */
  readonly batchKickHours: number;
  /** 是否正在防抖或请求当前回溯时间窗口的实时进群人数。 */
  readonly loadingWindowJoined: boolean;
  /** 是否正在提交 `/batch_kick` 批量清理请求。 */
  readonly batchKickSubmitting: boolean;
  /** 是否正在展开群详情顶部「目标与问答」下拉菜单。 */
  readonly targetsMenuOpen: boolean;
  /** 当前打开的目标管理弹窗类别（未打开时为 `null`）。 */
  readonly activeTargetsModal: MiniAppChatTargetKind | null;
  /** 当前群的问答对、追着删目标与追着翻目标清单快照。 */
  readonly chatTargets: MiniAppChatTargetsView | null;
  /** 是否正在拉取目标管理清单。 */
  readonly loadingTargets: boolean;
  /** 是否正在提交问答对、追着删目标或追着翻目标的增删请求。 */
  readonly mutatingTargets: boolean;
  /** 是否展开问答对的触发问题与自动回答编辑面板（默认收起为 `false`）。 */
  readonly qaEditorOpen: boolean;
  /** 是否展开删发言目标或翻译目标的三选一添加面板（默认收起为 `false`）。 */
  readonly targetAddMenuOpen: boolean;
  /** 是否展开删发言目标或翻译目标按 @username/ID 添加的内联输入框（默认收起为 `false`）。 */
  readonly targetIdFormOpen: boolean;
  /** 问答对表单的问题输入框内容。 */
  readonly qaQuestionInput: string;
  /** 问答对表单的答案输入框内容。 */
  readonly qaAnswerInput: string;
  /** 删发言目标输入框内容。 */
  readonly deleteTargetInput: string;
  /** 翻译目标输入框内容。 */
  readonly translateTargetInput: string;
  /** 翻译目标选中的目标语言。 */
  readonly translateLanguageInput: MiniAppTranslateLanguage;
  /** 是否展开翻译目标语言选择下拉菜单（默认收起为 `false`）。 */
  readonly translateLangMenuOpen: boolean;
  /** 是否正在查看当前群的热发言记录。 */
  readonly viewingMessages: boolean;
  /** 群列表当前页码（从 1 开始，渲染时夹到有效范围）。 */
  readonly chatPage: number;
  /** 群列表每页条数。 */
  readonly chatPageSize: number;

  /** 拉取群列表；只采纳最后一次发起的请求结果。 */
  readonly loadChatList: () => Promise<void>;
  /** 拉取指定群详情；只采纳最后一次发起的请求结果。 */
  readonly loadDetail: (chatId: number) => Promise<void>;
  /** 打开指定群的详情视图并加载详情。 */
  readonly selectChat: (chatId: number) => void;
  /** 关闭详情回到列表并重新加载群列表。 */
  readonly closeDetail: () => void;
  /** 进入当前群的热发言记录视图。 */
  readonly openMessages: () => void;
  /** 从热发言记录返回详情视图并重新加载详情。 */
  readonly closeMessages: () => void;
  /** 展开或收起群详情顶部的 Bot 管理员权限标签面板。 */
  readonly toggleBotPerms: () => void;
  /** 展开或收起群详情顶部的「目标与问答」下拉菜单。 */
  readonly toggleTargetsMenu: () => void;
  /** 关闭「目标与问答」下拉菜单。 */
  readonly closeTargetsMenu: () => void;
  /** 打开指定类别的目标管理弹窗并拉取最新目标清单。 */
  readonly openTargetsModal: (kind: MiniAppChatTargetKind) => void;
  /** 在已打开的目标管理弹窗内切换类别标签并收起问答编辑器及目标添加菜单。 */
  readonly switchTargetsModalTab: (kind: MiniAppChatTargetKind) => void;
  /** 关闭目标管理弹窗。 */
  readonly closeTargetsModal: () => void;
  /** 拉取当前群的目标管理清单。 */
  readonly loadChatTargets: () => Promise<void>;
  /** 展开问答对的触发问题与自动回答编辑面板。 */
  readonly openQaEditor: () => void;
  /** 收起问答对编辑面板并清空输入框。 */
  readonly closeQaEditor: () => void;
  /** 展开删发言目标或翻译目标的三选一添加面板。 */
  readonly openTargetAddMenu: () => void;
  /** 收起删发言目标或翻译目标的三选一添加面板与内联表单。 */
  readonly closeTargetAddMenu: () => void;
  /** 选择删发言目标或翻译目标添加方式：按 ID 时展开/收起内联表单，按联系人或频道时唤起 Telegram 原生选择器。 */
  readonly selectTargetAddMode: (mode: MiniAppIdentityAddMode) => void;
  /** 更新问答对表单的问题输入。 */
  readonly setQaQuestionInput: (value: string) => void;
  /** 更新问答对表单的答案输入。 */
  readonly setQaAnswerInput: (value: string) => void;
  /** 将一条现有问答对填入表单供修改。 */
  readonly fillQaPairForEdit: (q: string, a: string) => void;
  /** 更新删发言目标输入框内容。 */
  readonly setDeleteTargetInput: (value: string) => void;
  /** 更新翻译目标输入框内容。 */
  readonly setTranslateTargetInput: (value: string) => void;
  /** 更新翻译目标语言选择并收起语言下拉菜单。 */
  readonly setTranslateLanguageInput: (language: MiniAppTranslateLanguage) => void;
  /** 展开或收起翻译目标语言选择下拉菜单。 */
  readonly toggleTranslateLangMenu: () => void;
  /** 收起翻译目标语言选择下拉菜单。 */
  readonly closeTranslateLangMenu: () => void;
  /** 提交保存当前表单中的问答对。 */
  readonly submitQaPair: () => Promise<void>;
  /** 弹出确认后删除指定问题的问答对。 */
  readonly removeQaPair: (q: string) => Promise<void>;
  /** 提交新增删发言目标。 */
  readonly submitDeleteTarget: () => Promise<void>;
  /** 弹出确认后移除指定 ID 的删发言目标。 */
  readonly removeDeleteTarget: (targetId: number) => Promise<void>;
  /** 提交新增或更新翻译目标。 */
  readonly submitTranslateTarget: () => Promise<void>;
  /** 弹出确认后移除指定 ID 的翻译目标。 */
  readonly removeTranslateTarget: (targetId: number) => Promise<void>;
  /** 切换当前群的单项功能开关（关闭 `/init` 前先弹出确认，请求期间保持对应功能行最短骨架动画展示时长）。 */
  readonly toggleFeature: (feature: MiniAppFeatureKey, enabled: boolean) => Promise<void>;
  /** 更新 `/batch_kick` 回溯小时数（夹紧在 `1..24` 区间）。 */
  readonly setBatchKickHours: (hours: number) => void;
  /** 按当前选中的回溯小时数确认并触发 `/batch_kick` 批量清理。 */
  readonly runBatchKick: () => Promise<void>;
  /** 在后台 `/batch_kick` 执行期间静默刷新当前群详情，检测服务端完成回调写入的结束状态。 */
  readonly pollRunningBatchKick: () => Promise<void>;
  /** 切换群列表页码并播放最短加载骨架动画。 */
  readonly setChatPage: (page: number) => void;
  /** 切换群列表每页条数、回到第 1 页并播放最短加载骨架动画。 */
  readonly setChatPageSize: (pageSize: number) => void;
}

/** 一个 `ChatsPage` 实例独占的状态仓库。 */
export type MiniAppChatsStore = StoreApi<MiniAppChatsStoreState>;

/**
 * 创建 `ChatsPage` 的状态仓库；组件挂载时创建、卸载即丢弃，生命周期与组件实例一致。
 *
 * @returns 新的受管群列表仓库
 */
export function createChatsStore(): MiniAppChatsStore {
  return createStore<MiniAppChatsStoreState>()(
    (
      set: (partial: Partial<MiniAppChatsStoreState>) => void,
      get: () => MiniAppChatsStoreState
    ): MiniAppChatsStoreState => {
      let listReqSeq: number = 0;
      let detailReqSeq: number = 0;
      let targetsReqSeq: number = 0;
      let windowJoinedReqSeq: number = 0;
      let windowJoinedTimer: ReturnType<typeof setTimeout> | null = null;

      const cancelWindowJoinedRefresh = (): void => {
        if (windowJoinedTimer !== null) {
          clearTimeout(windowJoinedTimer);
          windowJoinedTimer = null;
        }
        windowJoinedReqSeq += 1;
      };

      const applyChatPagination = (
        partial: Pick<MiniAppChatsStoreState, "chatPage"> &
          Partial<Pick<MiniAppChatsStoreState, "chatPageSize">>
      ): void => {
        const reqId: number = ++listReqSeq;
        const startedAt: number = Date.now();
        set({ ...partial, loadingList: true });
        void (async (): Promise<void> => {
          await waitMinimumLoadingDuration(startedAt);
          if (reqId === listReqSeq) {
            set({ loadingList: false });
          }
        })();
      };

      const refreshWindowJoinedCount = async (reqId: number): Promise<void> => {
        const chatId: number | null = get().selectedChatId;
        if (chatId === null) {
          if (reqId === windowJoinedReqSeq) {
            set({ loadingWindowJoined: false });
          }
          return;
        }
        try {
          const detail: MiniAppChatDetail = await fetchMiniAppChatDetail(chatId);
          if (reqId !== windowJoinedReqSeq || get().selectedChatId !== chatId) {
            return;
          }
          set({ chatDetail: detail, loadingWindowJoined: false });
        } catch (error: unknown) {
          if (reqId !== windowJoinedReqSeq || get().selectedChatId !== chatId) {
            return;
          }
          set({ loadingWindowJoined: false });
          const message: string = errorMessage(error);
          useMiniAppStore.getState().notify(message, "info", error);
        }
      };

      return {
        chats: [],
        loadingList: true,
        selectedChatId: null,
        chatDetail: null,
        loadingDetail: false,
        botPermsExpanded: false,
        togglingFeature: null,
        batchKickHours: MINI_APP_BATCH_KICK_DEFAULT_HOURS,
        loadingWindowJoined: false,
        batchKickSubmitting: false,
        targetsMenuOpen: false,
        activeTargetsModal: null,
        chatTargets: null,
        loadingTargets: false,
        mutatingTargets: false,
        qaEditorOpen: false,
        targetAddMenuOpen: false,
        targetIdFormOpen: false,
        qaQuestionInput: "",
        qaAnswerInput: "",
        deleteTargetInput: "",
        translateTargetInput: "",
        translateLanguageInput: "ja",
        translateLangMenuOpen: false,
        viewingMessages: false,
        chatPage: 1,
        chatPageSize: MINI_APP_CHATS_DEFAULT_PAGE_SIZE,

        loadChatList: async (): Promise<void> => {
          const reqId: number = ++listReqSeq;
          const startedAt: number = Date.now();
          set({ loadingList: true });
          try {
            const items: readonly Readonly<MiniAppChatSummary>[] = await fetchMiniAppChats();
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== listReqSeq) {
              return;
            }
            set({ chats: items });
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== listReqSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (reqId === listReqSeq) {
              set({ loadingList: false });
            }
          }
        },

        loadDetail: async (chatId: number): Promise<void> => {
          cancelWindowJoinedRefresh();
          const reqId: number = ++detailReqSeq;
          const startedAt: number = Date.now();
          set({ loadingDetail: true, loadingWindowJoined: false });
          try {
            const detail: MiniAppChatDetail = await fetchMiniAppChatDetail(chatId);
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== detailReqSeq) {
              return;
            }
            set({ chatDetail: detail });
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            if (reqId !== detailReqSeq) {
              return;
            }
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (reqId === detailReqSeq) {
              set({ loadingDetail: false });
            }
          }
        },

        selectChat: (chatId: number): void => {
          cancelWindowJoinedRefresh();
          targetsReqSeq += 1;
          set({
            selectedChatId: chatId,
            viewingMessages: false,
            chatDetail: null,
            botPermsExpanded: false,
            loadingWindowJoined: false,
            targetsMenuOpen: false,
            activeTargetsModal: null,
            chatTargets: null,
            loadingTargets: false,
            mutatingTargets: false,
            qaEditorOpen: false,
            targetAddMenuOpen: false,
            targetIdFormOpen: false,
            qaQuestionInput: "",
            qaAnswerInput: "",
            deleteTargetInput: "",
            translateTargetInput: "",
            translateLanguageInput: "ja",
            translateLangMenuOpen: false,
          });
          void get().loadDetail(chatId);
        },

        closeDetail: (): void => {
          cancelWindowJoinedRefresh();
          targetsReqSeq += 1;
          set({
            selectedChatId: null,
            chatDetail: null,
            botPermsExpanded: false,
            loadingWindowJoined: false,
            targetsMenuOpen: false,
            activeTargetsModal: null,
            chatTargets: null,
            loadingTargets: false,
            mutatingTargets: false,
            qaEditorOpen: false,
            targetAddMenuOpen: false,
            targetIdFormOpen: false,
            translateLangMenuOpen: false,
          });
          void get().loadChatList();
        },

        openMessages: (): void => {
          cancelWindowJoinedRefresh();
          set({
            viewingMessages: true,
            loadingWindowJoined: false,
            targetsMenuOpen: false,
            activeTargetsModal: null,
            qaEditorOpen: false,
            targetAddMenuOpen: false,
            targetIdFormOpen: false,
            translateLangMenuOpen: false,
          });
        },

        closeMessages: (): void => {
          set({ viewingMessages: false });
          const chatId: number | null = get().selectedChatId;
          if (chatId !== null) {
            void get().loadDetail(chatId);
          }
        },

        toggleBotPerms: (): void => {
          set({ botPermsExpanded: !get().botPermsExpanded });
        },

        ...createChatTargetsActions({
          set,
          get,
          nextTargetsReqSeq: (): number => {
            targetsReqSeq += 1;
            return targetsReqSeq;
          },
          currentTargetsReqSeq: (): number => targetsReqSeq,
        }),

        toggleFeature: async (
          feature: MiniAppFeatureKey,
          enabled: boolean
        ): Promise<void> => {
          const chatId: number | null = get().selectedChatId;
          if (chatId === null) return;
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          if (
            feature === "init" &&
            !enabled &&
            !(await app.requestConfirm(
              getMiniAppTranslations(app.language).chats.confirmDisableInit,
              "danger"
            ))
          ) {
            return;
          }
          const startedAt: number = Date.now();
          set({ togglingFeature: feature });
          try {
            const result: MiniAppFeatureToggleResult = await toggleMiniAppChatFeature(
              chatId,
              feature,
              enabled
            );
            await waitMinimumLoadingDuration(startedAt);
            if (result.removedFromList || result.detail === null) {
              set({
                selectedChatId: null,
                chatDetail: null,
                chats: [],
                loadingList: true,
                togglingFeature: null,
              });
              await get().loadChatList();
              useMiniAppStore.getState().notify(
                result.message,
                result.ok ? "info" : "warning",
                result
              );
            } else {
              set({ chatDetail: result.detail, togglingFeature: null });
              useMiniAppStore.getState().notify(
                result.message,
                result.ok ? "info" : "warning",
                result
              );
            }
          } catch (error: unknown) {
            await waitMinimumLoadingDuration(startedAt);
            set({ togglingFeature: null });
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "info", error);
          } finally {
            if (get().togglingFeature !== null) {
              set({ togglingFeature: null });
            }
          }
        },

        setBatchKickHours: (hours: number): void => {
          const normalized: number = Number.isFinite(hours)
            ? Math.trunc(hours)
            : MINI_APP_BATCH_KICK_MIN_HOURS;
          const safeHours: number = Math.min(
            MINI_APP_BATCH_KICK_MAX_HOURS,
            Math.max(MINI_APP_BATCH_KICK_MIN_HOURS, normalized)
          );
          const current: MiniAppChatsStoreState = get();
          if (safeHours === current.batchKickHours && !current.loadingWindowJoined) {
            return;
          }
          cancelWindowJoinedRefresh();
          if (current.selectedChatId === null) {
            set({ batchKickHours: safeHours, loadingWindowJoined: false });
            return;
          }
          const reqId: number = windowJoinedReqSeq;
          set({ batchKickHours: safeHours, loadingWindowJoined: true });
          windowJoinedTimer = setTimeout((): void => {
            windowJoinedTimer = null;
            void refreshWindowJoinedCount(reqId);
          }, MINI_APP_BATCH_KICK_WINDOW_DEBOUNCE_MS);
        },

        runBatchKick: async (): Promise<void> => {
          const {
            selectedChatId,
            batchKickHours,
            batchKickSubmitting,
          }: MiniAppChatsStoreState = get();
          if (selectedChatId === null || batchKickSubmitting) return;
          const app: MiniAppUiStoreState = useMiniAppStore.getState();
          if (
            !(await app.requestConfirm(
              getMiniAppTranslations(app.language).chats.confirmBatchKick(batchKickHours),
              "danger"
            ))
          ) {
            return;
          }
          cancelWindowJoinedRefresh();
          set({ batchKickSubmitting: true, loadingWindowJoined: false });
          try {
            const result: MiniAppBatchKickResult = await triggerMiniAppChatBatchKick(
              selectedChatId,
              batchKickHours
            );
            useMiniAppStore.getState().notify(
              result.message,
              result.outcome === "accepted" ? "info" : "warning",
              result
            );
            if (result.outcome === "notInitialized" || result.detail === null) {
              set({ selectedChatId: null, chatDetail: null, chats: [], loadingList: true });
              void get().loadChatList();
            } else {
              set({ chatDetail: result.detail });
            }
          } catch (error: unknown) {
            const message: string = errorMessage(error);
            useMiniAppStore.getState().notify(message, "warning", error);
          } finally {
            set({ batchKickSubmitting: false });
          }
        },

        pollRunningBatchKick: async (): Promise<void> => {
          const {
            selectedChatId,
            chatDetail,
            batchKickSubmitting,
          }: MiniAppChatsStoreState = get();
          if (
            selectedChatId === null ||
            batchKickSubmitting ||
            chatDetail?.batchKickRunning !== true
          ) {
            return;
          }
          try {
            const nextDetail: Readonly<MiniAppChatDetail> =
              await fetchMiniAppChatDetail(selectedChatId);
            const current: MiniAppChatsStoreState = get();
            if (current.selectedChatId !== selectedChatId) return;
            const wasRunning: boolean = current.chatDetail?.batchKickRunning === true;
            set({ chatDetail: nextDetail });
            if (
              wasRunning &&
              !nextDetail.batchKickRunning &&
              nextDetail.lastBatchKickCompletion !== null
            ) {
              const app: MiniAppUiStoreState = useMiniAppStore.getState();
              app.notify(
                getMiniAppTranslations(app.language).chats.batchKickCompletedSummary(
                  nextDetail.lastBatchKickCompletion
                ),
                "info"
              );
            }
          } catch (_error: unknown) {
            // 后台轮询遇瞬时异常时静默等待下一轮。
          }
        },

        setChatPage: (page: number): void => {
          applyChatPagination({ chatPage: page });
        },

        setChatPageSize: (pageSize: number): void => {
          applyChatPagination({ chatPage: 1, chatPageSize: pageSize });
        },
      };
    }
  );
}
