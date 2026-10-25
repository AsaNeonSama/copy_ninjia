import type { WhitelistPermissionKey } from "./identityPolicy";
import type {
  MiniAppActiveSessionCounts,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppIdentityAddMode,
  MiniAppIdentitySubTabKey,
  MiniAppTabKey,
} from "./miniApp";

/** Mini App 界面三语言（中/日/英）杂鱼语气文案结构定义。 */
export interface MiniAppTranslations {
  readonly languageLabel: string;
  readonly appTitle: string;
  readonly appSubtitle: string;
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

  readonly gate: Readonly<{
    readonly checkingText: string;
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
    readonly deniedPolicyReason: (code: string, fallbackError: string) => string;
    readonly deniedWhatCanIDoTitle: string;
    readonly deniedWhatCanIDoDesc: string;
    readonly passwordBadge: string;
    readonly passwordTitle: string;
    readonly passwordSubtitle: string;
    readonly passwordPlaceholder: string;
    readonly passwordEmptyHint: string;
    readonly passwordSubmitting: string;
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
    readonly verifyingButton: string;
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
    readonly memoryPeakLabel: string;
    readonly memorySub: (currentRss: string, heapUsed: string) => string;
    readonly managedChatsLabel: string;
    readonly managedChatsSub: (whitelistCount: number, blocklistCount: number) => string;
    readonly activeSessionsLabel: string;
    readonly activeSessionsSub: (sessions: Readonly<MiniAppActiveSessionCounts>) => string;
    readonly outboundGateLabel: string;
    readonly outboundGateSub: (waiting: number, retrySize: number, retryMax: number) => string;
    readonly capabilitiesSectionTitle: string;
    readonly capabilityReadyBadge: string;
    readonly capabilityMissingBadge: string;
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
    readonly viewMessagesButton: (hotCount: number, hotMax: number) => string;
    readonly closeDetailButton: string;
    readonly botPermProbing: string;
    readonly botPermAllReady: string;
    readonly botPermMissingTitle: (count: number) => string;
    readonly botPermLabel: (rawLabel: string) => string;
    readonly detailStatsLine: (detail: Readonly<MiniAppChatDetail>) => string;
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
    readonly searchPlaceholder: (subTab: MiniAppIdentitySubTabKey) => string;
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
