import type { WhitelistPermissionKey } from "./identityPolicy";
import type {
  MiniAppActiveSessionCounts,
  MiniAppBatchKickCompletion,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppChatTargetKind,
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppIdentitySubTabKey,
  MiniAppPickerTargetList,
  MiniAppTabKey,
  MiniAppTranslateLanguage,
} from "./miniApp";

/** 服务端英文状态码映射为多语言提示时的可选插值参数。 */
export interface MiniAppServerNoticeParams {
  /** 切换后的全局情绪名称（仅 `MOOD_SWITCHED` 使用）。 */
  readonly mood?: string | null;
  /** 群功能键（仅群功能开关状态码使用）。 */
  readonly feature?: MiniAppFeatureKey;
  /** 未就绪的配置文件名（仅 `FEATURE_CONFIG_NOT_READY` 使用）。 */
  readonly configFile?: string;
  /** 目标身份 ID（仅白名单/黑名单/权限状态码使用）。 */
  readonly id?: number;
  /** 单个白名单权限键（仅 `PERMISSION_UPDATED` / `PERMISSION_UNCHANGED` 使用）。 */
  readonly key?: WhitelistPermissionKey;
  /** 单个白名单权限布尔值（仅 `PERMISSION_UPDATED` / `PERMISSION_UNCHANGED` 使用）。 */
  readonly value?: boolean;
  /** 磁盘持久化是否已完成（仅黑名单状态码使用）。 */
  readonly persisted?: boolean;
  /** 跨群成功处置的受管群数量（仅黑名单状态码使用）。 */
  readonly affectedChats?: number;
  /** 受管管理员群总数量（仅黑名单状态码使用）。 */
  readonly totalChats?: number;
  /** 原生选择器目标名单类型（仅 `PICKER_IMPORT_*` 使用）。 */
  readonly targetList?: MiniAppPickerTargetList;
  /** 原生选择器新加入数量（仅 `PICKER_IMPORT_*` 使用）。 */
  readonly addedCount?: number;
  /** 原生选择器跳过数量（仅 `PICKER_IMPORT_*` 使用）。 */
  readonly skippedCount?: number;
  /** 原生选择器重复数量（仅 `PICKER_IMPORT_*` 使用）。 */
  readonly duplicateCount?: number;
  /** 图库图片文件名（仅 `GALLERY_*` 使用）。 */
  readonly fileName?: string;
  /** 图片像素宽度（仅 `GALLERY_INVALID_DIMENSIONS` 使用）。 */
  readonly width?: number;
  /** 图片像素高度（仅 `GALLERY_INVALID_DIMENSIONS` 使用）。 */
  readonly height?: number;
  /** 剩余可尝试次数（仅 `INVALID_PASSWORD` / `INVALID_TOTP_CODE` 使用）。 */
  readonly remainingAttempts?: number;
  /** 剩余锁定分钟数（仅 `PASSWORD_LOCKED` 使用）。 */
  readonly remainingMinutes?: number;
  /** 批量踢人回溯小时数（仅 `BATCH_KICK_*` 使用）。 */
  readonly hours?: number;
  /** 批量踢人回溯窗口命中的入群记录条数（仅 `BATCH_KICK_*` 使用）。 */
  readonly recordCount?: number;
}

/** Mini App 界面三语言（中/日/英）杂鱼语气文案结构定义。 */
export interface MiniAppTranslations {
  readonly languageLabel: string;
  readonly appTitle: string;
  readonly superAdminBadge: string;
  readonly lockButton: string;
  readonly lockSessionToast: string;
  readonly sessionExpiredToast: string;
  readonly themeLightLabel: string;
  readonly themeDarkLabel: string;
  readonly sidebarTitle: string;
  readonly sidebarSubtitle: string;
  readonly sidebarOpenAria: string;
  readonly sidebarCloseAria: string;
  readonly sidebarFooterHint: string;
  readonly tabs: Readonly<Record<MiniAppTabKey, string>>;
  readonly tabDescriptions: Readonly<Record<MiniAppTabKey, string>>;
  /** 将后端返回的英文状态码字串映射为当前语言的提示文案；未知文本原样返回。 */
  readonly serverNotice: (
    code: string,
    params?: Readonly<MiniAppServerNoticeParams>
  ) => string;

  readonly gate: Readonly<{
    readonly deniedTitle: string;
    readonly deniedDescription: string;
    readonly deniedNodeClientSub: string;
    readonly deniedNodeClientTitle: string;
    readonly deniedNodeClientState: string;
    readonly deniedNodeGatewaySub: string;
    readonly deniedNodeGatewayTitle: string;
    readonly deniedNodeGatewayState: (status: number) => string;
    readonly deniedNodeOriginSub: string;
    readonly deniedNodeOriginState: string;
    readonly deniedWhatHappenedTitle: string;
    readonly deniedWhatHappenedDesc: string;
    readonly deniedPolicyDetailLabel: (code: string) => string;
    readonly deniedPolicyReason: (
      code: string,
      fallbackError: string,
      params?: Readonly<MiniAppServerNoticeParams>
    ) => string;
    readonly deniedWhatCanIDoTitle: string;
    readonly deniedWhatCanIDoDesc: string;
    readonly passwordBadge: string;
    readonly passwordTitle: string;
    readonly passwordSubtitle: string;
    readonly passwordPlaceholder: string;
    readonly passwordEmptyHint: string;
    readonly passwordSubmitButton: string;
    readonly totpBadge: string;
    readonly totpTitle: string;
    readonly totpSubtitle: string;
    readonly totpPlaceholder: string;
    readonly totpEmptyHint: string;
    readonly totpSubmitButton: string;
    readonly unlockedToast: string;
  }>;

  readonly totp: Readonly<{
    readonly sectionTitle: string;
    readonly enabledBadge: string;
    readonly disabledBadge: string;
    readonly statusDescEnabled: (maskedSecret: string, updatedAtText: string) => string;
    readonly statusDescDisabled: string;
    readonly addButton: string;
    readonly modifyButton: string;
    readonly deleteButton: string;
    readonly qrGuideText: string;
    readonly secretLabel: string;
    readonly codePlaceholder: string;
    readonly verifyEnableButton: string;
    readonly cancelSetupButton: string;
    readonly confirmDeleteTotp: string;
  }>;

  readonly pagination: Readonly<{
    readonly summary: (total: number, page: number, totalPages: number) => string;
    readonly pageSizeOption: (size: number) => string;
    readonly firstPageAria: string;
    readonly prevPageAria: string;
    readonly nextPageAria: string;
    readonly lastPageAria: string;
  }>;

  readonly confirmDialog: Readonly<{
    readonly title: string;
    readonly confirmButton: string;
    readonly cancelButton: string;
  }>;

  readonly status: Readonly<{
    readonly loadingText: string;
    readonly uptimeLabel: string;
    readonly updatedAtSub: (timeText: string) => string;
    readonly cpuLoadLabel: string;
    readonly cpuLoadSub: string;
    readonly memoryCurrentLabel: string;
    readonly memoryPeakLabel: string;
    readonly memoryHeapLabel: string;
    readonly memoryProcessUsedLabel: string;
    readonly memoryOtherUsedLabel: string;
    readonly memoryTotalUsedLabel: string;
    readonly managedChatsLabel: string;
    readonly managedChatsSub: (whitelistCount: number, blocklistCount: number) => string;
    readonly activeSessionsLabel: string;
    readonly activeSessionsSub: (
      sessions: Readonly<MiniAppActiveSessionCounts>
    ) => readonly [string, string, string, string];
    readonly outboundGateLabel: string;
    readonly outboundGateSub: (waiting: number, retrySize: number, retryMax: number) => string;
    readonly capabilitiesSectionTitle: string;
    readonly capabilityReadyBadge: string;
    readonly capabilityMissingBadge: string;
    readonly capabilityItemCount: (count: number) => string;
    readonly moodCurrentLabel: string;
    readonly moodCurrentActiveBadge: string;
    readonly moodUnavailableText: string;
    readonly moodSwitchButton: string;
    readonly capabilityLabel: (capability: Readonly<MiniAppCapabilityStatus>) => string;
    readonly capabilityItem: (
      item: Readonly<MiniAppCapabilityDetailItem>
    ) => Readonly<MiniAppCapabilityDetailItem>;
  }>;

  readonly chats: Readonly<{
    readonly sectionTitle: (count: number) => string;
    readonly refreshButton: string;
    readonly loadingChatsText: string;
    readonly emptyChatsHint: string;
    readonly lockdownBadge: string;
    readonly chatCardMeta: (chatId: number, hotCount: number, qaCount: number) => string;
    readonly detailSectionTitle: string;
    readonly viewMessagesButton: string;
    readonly targetsMenuButton: string;
    readonly targetsKindLabel: Readonly<Record<MiniAppChatTargetKind, string>>;
    readonly targetsModalSubtitle: (
      chatTitle: string,
      count: number,
      maxCount: number
    ) => string;
    readonly targetsCloseButton: string;
    readonly targetsRefreshButton: string;
    readonly qaOpenEditorButton: string;
    readonly qaCancelEditButton: string;
    readonly qaQuestionLabel: string;
    readonly qaQuestionPlaceholder: (maxChars: number) => string;
    readonly qaAnswerLabel: string;
    readonly qaAnswerPlaceholder: (maxChars: number) => string;
    readonly qaSaveButton: string;
    readonly qaSavingButton: string;
    readonly qaEditButton: string;
    readonly qaDeleteButton: string;
    readonly confirmDeleteQa: (q: string) => string;
    readonly qaEmptyHint: string;
    readonly deleteTargetInputPlaceholder: string;
    readonly deleteTargetAddButton: string;
    readonly deleteTargetAddingButton: string;
    readonly deleteTargetRemoveButton: string;
    readonly confirmRemoveDeleteTarget: (displayName: string, id: number) => string;
    readonly deleteTargetEmptyHint: string;
    readonly translateTargetInputPlaceholder: string;
    readonly translateLanguageLabels: Readonly<Record<MiniAppTranslateLanguage, string>>;
    readonly translateTargetAddButton: string;
    readonly translateTargetAddingButton: string;
    readonly translateTargetRemoveButton: string;
    readonly confirmRemoveTranslateTarget: (displayName: string, id: number) => string;
    readonly translateTargetEmptyHint: string;
    readonly closeDetailButton: string;
    readonly botPermProbing: string;
    readonly botPermNone: string;
    readonly botPermGrantedTitle: (count: number) => string;
    readonly botPermLabel: (rawLabel: string) => string;
    readonly detailStatsLine: (detail: Readonly<MiniAppChatDetail>) => string;
    readonly joinCleanSectionTitle: string;
    readonly batchKickRunningBadge: string;
    readonly windowJoinedLabel: string;
    readonly windowJoinedSub: (hours: number) => string;
    readonly windowJoinedValue: (count: number) => string;
    readonly batchKickWindowLabel: string;
    readonly batchKickHourPill: (hours: number) => string;
    readonly batchKickDecreaseAria: string;
    readonly batchKickIncreaseAria: string;
    readonly batchKickTriggerButton: (hours: number) => string;
    readonly batchKickRunningButton: string;
    readonly batchKickCompletedSummary: (
      completion: Readonly<MiniAppBatchKickCompletion>
    ) => string;
    readonly confirmBatchKick: (hours: number) => string;
    readonly featuresSectionTitle: string;
    readonly confirmDisableInit: string;
    readonly featureMeta: Readonly<Record<MiniAppFeatureKey, Readonly<MiniAppFeatureDisplayMeta>>>;
  }>;

  readonly messages: Readonly<{
    readonly backButton: string;
    readonly refreshButton: string;
    readonly headerTitle: (title: string, total: number, maxCapacity: number) => string;
    readonly headerMeta: (chatId: number) => string;
    readonly loadingText: string;
    readonly emptyHint: string;
    readonly replyBadge: (name: string, preview: string) => string;
    readonly forwardBadge: (from: string) => string;
    readonly emptyMediaPlaceholder: string;
  }>;

  readonly identities: Readonly<{
    readonly whitelistTab: string;
    readonly blocklistTab: string;
    readonly searchPlaceholder: string;
    readonly searchClearAria: string;
    readonly searchDebounceHint: string;
    readonly addFoldButton: string;
    readonly addModes: Readonly<Record<MiniAppIdentityAddMode, string>>;
    readonly addModeDescriptions: Readonly<Record<MiniAppIdentityAddMode, string>>;
    readonly idInputPlaceholder: string;
    readonly idConfirmButton: string;
    readonly idCancelButton: string;
    readonly invalidIdToast: string;
    readonly duplicateToast: (idText: string, subTab: MiniAppIdentitySubTabKey) => string;
    readonly duplicateBannerTitle: string;
    readonly pickerUnsupportedHint: string;
    readonly pickerCancelledToast: string;
    readonly pickerWaitingToast: string;
    readonly pickerTimeoutToast: string;
    readonly loadingText: string;
    readonly emptySearchHint: (query: string) => string;
    readonly emptyListHint: (subTab: MiniAppIdentitySubTabKey) => string;
    readonly channelBadge: string;
    readonly userBadge: string;
    readonly blockedAtText: (timeText: string) => string;
    readonly enabledPermCountText: (enabledCount: number, totalCount: number) => string;
    readonly configurePermButton: string;
    readonly removeWhitelistButton: string;
    readonly removeBlocklistButton: string;
    readonly confirmRemoveWhitelist: (displayName: string, id: number) => string;
    readonly confirmRemoveBlocklist: (displayName: string, id: number) => string;
  }>;

  readonly permissionDrawer: Readonly<{
    readonly title: (displayName: string) => string;
    readonly subtitle: (id: number, isChannel: boolean) => string;
    readonly enableAllButton: string;
    readonly closeButton: string;
    readonly labels: Readonly<Record<WhitelistPermissionKey, string>>;
  }>;

  readonly gallery: Readonly<{
    readonly sectionTitle: string;
    readonly refreshButton: string;
    readonly uploadingButton: string;
    readonly uploadButton: string;
    readonly directoryMissingText: (directory: string) => string;
    readonly directoryReadyText: (directory: string) => string;
    readonly previewTitle: (shortName: string) => string;
    readonly downloadButton: string;
    readonly downloadingButton: string;
    readonly downloadedToast: (fileName: string) => string;
    readonly deleteButton: string;
    readonly deletingButton: string;
    readonly closePreviewButton: string;
    readonly confirmDeleteImage: (fileName: string) => string;
    readonly deletedToast: (fileName: string) => string;
    readonly loadingText: string;
    readonly emptyMissingDirHint: string;
    readonly emptyGalleryHint: string;
  }>;
}
