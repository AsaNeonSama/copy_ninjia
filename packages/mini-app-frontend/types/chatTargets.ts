/** 受管群「目标与问答」弹窗外框与各子面板按需订阅的 `MiniAppChatsStoreState` 切片类型（components/ChatTargetsModal.tsx 的选择器产出）。 */

import type { MiniAppChatsStoreState } from "../store/chats";

/** `ChatTargetsModal` 弹窗外框订阅的状态与动作切片（不含各类表单草稿输入框）。 */
export type ChatTargetsModalShellSlice = Pick<
  MiniAppChatsStoreState,
  | "activeTargetsModal"
  | "chatDetail"
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "translateLangMenuOpen"
  | "qaEditorOpen"
  | "targetAddMenuOpen"
  | "openQaEditor"
  | "openTargetAddMenu"
  | "closeTranslateLangMenu"
  | "switchTargetsModalTab"
  | "closeTargetsModal"
  | "loadChatTargets"
>;

/** 问答对编辑表单订阅的状态与动作切片。 */
export type ChatTargetsQaEditorFormSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "mutatingTargets"
  | "qaEditorOpen"
  | "qaQuestionInput"
  | "qaAnswerInput"
  | "qaEditSourceQuestion"
  | "closeQaEditor"
  | "setQaQuestionInput"
  | "setQaAnswerInput"
  | "submitQaPair"
>;

/** 成员目标添加表单订阅的状态与动作切片。 */
export type ChatTargetsMemberAddFormSlice = Pick<
  MiniAppChatsStoreState,
  | "mutatingTargets"
  | "targetAddMenuOpen"
  | "targetIdFormOpen"
  | "deleteTargetInput"
  | "translateTargetInput"
  | "translateLanguageInput"
  | "translateLangMenuOpen"
  | "closeTargetAddMenu"
  | "selectTargetAddMode"
  | "setDeleteTargetInput"
  | "setTranslateTargetInput"
  | "setTranslateLanguageInput"
  | "toggleTranslateLangMenu"
  | "submitDeleteTarget"
  | "submitTranslateTarget"
>;

/** 问答对列表面板订阅的状态与动作切片。 */
export type ChatTargetsQaPanelSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "fillQaPairForEdit"
  | "removeQaPair"
>;

/** 成员目标列表面板订阅的状态与动作切片。 */
export type ChatTargetsMemberPanelsSlice = Pick<
  MiniAppChatsStoreState,
  | "chatTargets"
  | "loadingTargets"
  | "mutatingTargets"
  | "removeDeleteTarget"
  | "removeTranslateTarget"
>;
