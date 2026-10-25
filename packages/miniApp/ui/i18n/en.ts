import type {
  MiniAppActiveSessionCounts,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppIdentitySubTabKey,
} from "../../../types/miniApp";
import type { MiniAppTranslations } from "../../../types/miniAppI18n";

/**
 * 返回英文（Zaako♡ 杂鱼语气）的 Mini App 界面文案字典。
 *
 * @returns 英文界面文案对象
 */
export function getEnTranslations(): Readonly<MiniAppTranslations> {
  const capabilityLabels: Readonly<Record<string, string>> = {
    aiChat: "AI Chat & Multimodal",
    translate: "Auto Translation Engine",
    adDetect: "AI Ad Detection",
    stickers: "Sticker Packs",
    mood: "AI Mood Pool",
    cron: "Scheduled Cron Tasks",
    hImage: "Random H-Image Gallery (/h_image)",
    randomHImage: "Random H-Image Gallery (/h_image)",
  };
  return {
    languageLabel: "EN",
    appTitle: "Bot Console♡",
    appSubtitle: "This Genius's command deck built for a clueless Zaako admin",
    superAdminBadge: "SuperAdmin",
    lockButton: "Lock",
    lockSessionToast: "Hmph, locked the session for you, careless Zaako♡",
    sessionExpiredToast: "Zaako, your 90-minute session expired! Be a good kid and re-enter the password!",
    themeLightLabel: "Light",
    themeDarkLabel: "Dark",
    sidebarTitle: "Navigation",
    sidebarSubtitle: "Which module are you peeking at today, Zaako?",
    sidebarOpenAria: "Open navigation sidebar",
    sidebarCloseAria: "Close navigation sidebar",
    sidebarFooterHint: "This Genius is watching over your system 24/7, be grateful♡",
    tabs: {
      status: "Live Status",
      chats: "Managed Chats",
      identities: "Access Control",
      gallery: "H-Image Gallery",
      totp: "Authenticator",
    },
    tabDescriptions: {
      status: "CPU, RAM, outbound gate & readiness",
      chats: "/init switches & hot 256 messages",
      identities: "Whitelist 18 perms & blocklist",
      gallery: "/h_image preview, upload & delete",
      totp: "Google Authenticator (TOTP) setup, replace & delete",
    },
    gate: {
      checkingText: "Verifying your SuperAdmin signature, sit tight Zaako…",
      deniedTitle: "Access denied, Zaako♡",
      deniedDescription:
        "Hmph, a Zaako like you doesn't have permission to peek at this console from an external browser or unauthorized client.",
      deniedNodeClientSub: "Client",
      deniedNodeClientTitle: "Zaako's Browser",
      deniedNodeClientState: "Working",
      deniedNodeGatewaySub: "Access Gateway",
      deniedNodeGatewayTitle: "Auth Guard",
      deniedNodeGatewayState: (status: number): string => `${status} Denied`,
      deniedNodeOriginSub: "Origin Service",
      deniedNodeOriginState: "Protected",
      deniedWhatHappenedTitle: "What happened, Zaako?",
      deniedWhatHappenedDesc:
        "This endpoint enforces strict Telegram WebApp signature verification and administrator access control. The request a Zaako like you just sent failed policy validation and got kicked right out.",
      deniedPolicyDetailLabel: (code: string): string => `Policy Detail (${code})`,
      deniedPolicyReason: (code: string, fallbackError: string): string => {
        const upper: string = code.toUpperCase();
        if (
          upper === "MISSING_INIT_DATA" ||
          upper === "MALFORMED_INIT_DATA" ||
          upper === "MISSING_HASH" ||
          upper === "MISSING_USER"
        ) {
          return `Telegram WebApp initData verification failed (${code}). Direct peeking from an external browser is strictly denied, Zaako.`;
        }
        if (upper === "INVALID_SIGNATURE") {
          return `Telegram WebApp signature verification failed (${code}). Forging signatures won't work, Zaako.`;
        }
        if (upper === "EXPIRED_AUTH_DATE") {
          return `Telegram WebApp signature has expired (${code}). Reopen the panel from Telegram for a fresh signature, Zaako.`;
        }
        if (upper === "FORBIDDEN_USER") {
          return "Only the configured SuperAdmin user ID is allowed in this Mini App. Hands off, Zaako.";
        }
        if (upper === "CROSS_SITE_FORBIDDEN") {
          return `Cross-site request to Telegram Mini App endpoint is forbidden (${code}), Zaako.`;
        }
        return fallbackError;
      },
      deniedWhatCanIDoTitle: "What can a Zaako do?",
      deniedWhatCanIDoDesc:
        "Direct HTTP access outside Telegram is prohibited. If you're really the SuperAdmin, behave and open the private chat with the Bot in Telegram, launch the App button, and enter your access password, Zaako.",
      passwordBadge: "2nd-Factor Gate",
      passwordTitle: "Hand Over the Password, Zaako",
      passwordSubtitle:
        "Your Telegram signature barely passed. Now enter the console access password to unlock a 90-minute session (3 wrong tries locks you out for 30 minutes).",
      passwordPlaceholder: "Type the access password carefully, Zaako…",
      passwordEmptyHint: "Clueless Zaako, trying to sneak in with an empty password box?",
      passwordSubmitting: "Checking for you…",
      passwordSubmitButton: "Unlock Console",
      totpBadge: "Authenticator Gate",
      totpTitle: "Hand Over the 6-Digit Code, Zaako",
      totpSubtitle:
        "Google Authenticator is enabled and prioritized. Enter your current 6-digit TOTP code to unlock a 90-minute session (3 wrong tries locks you out for 30 minutes).",
      totpPlaceholder: "Enter 6-digit Google Authenticator code…",
      totpEmptyHint: "Clueless Zaako, enter all 6 digits of your TOTP code first!",
      totpSubmitButton: "Verify Code & Unlock",
      unlockedToast: "Hmph, good job. Unlocked for 90 minutes, Zaako♡",
    },
    totp: {
      sectionTitle: "Google Authenticator",
      enabledBadge: "Prioritized",
      disabledBadge: "Disabled (Password Mode)",
      statusDescEnabled: (maskedSecret: string, updatedAtText: string): string =>
        `Active secret: ${maskedSecret} · Updated ${updatedAtText} (Prioritized at login)`,
      statusDescDisabled:
        "No Google Authenticator bound yet (using bot.json password). Generate a QR code right here to bind the single authenticator.",
      addButton: "Add TOTP",
      modifyButton: "Modify TOTP",
      deleteButton: "Delete TOTP",
      qrGuideText:
        "Scan the QR code below with Google Authenticator (or enter the Base32 secret manually), then enter the 6-digit code to activate:",
      secretLabel: "Base32 Secret:",
      codePlaceholder: "Enter 6-digit code…",
      verifyEnableButton: "Verify & Save",
      verifyingButton: "Verifying…",
      cancelSetupButton: "Cancel",
      confirmDeleteTotp:
        "Zaako, delete the current Google Authenticator? Login will fall back to the access password!",
    },
    pagination: {
      summary: (total: number, page: number, totalPages: number): string =>
        `${total} total · Page ${page}/${totalPages}`,
      pageSizeOption: (size: number): string => `${size}/p`,
      firstPageAria: "First",
      prevPageAria: "Prev",
      nextPageAria: "Next",
      lastPageAria: "Last",
    },
    confirmDialog: {
      title: "Final Confirmation, Zaako",
      confirmButton: "Confirm",
      cancelButton: "Nevermind",
    },
    status: {
      loadingText: "Fetching live runtime telemetry for you, don't rush me Zaako…",
      uptimeLabel: "Process Uptime",
      updatedAtSub: (timeText: string): string => `Synced at ${timeText}`,
      cpuLoadLabel: "CPU Avg Load",
      cpuLoadSub: "Smoothed sampling window load",
      memoryCurrentLabel: "Current Memory",
      memoryPeakLabel: "Peak Memory",
      memoryHeapLabel: "JS Heap",
      memoryProcessUsedLabel: "Current Process",
      memoryOtherUsedLabel: "Other Processes",
      memoryTotalUsedLabel: "Total Used",
      memorySub: (currentRss: string, heapUsed: string): string =>
        `Current RSS ${currentRss} · Heap ${heapUsed}`,
      memoryHeapSub: (heapUsed: string): string => `JS Heap ${heapUsed}`,
      managedChatsLabel: "/init Managed Chats",
      managedChatsSub: (whitelistCount: number, blocklistCount: number): string =>
        `Whitelist ${whitelistCount} · Blocklist ${blocklistCount}`,
      activeSessionsLabel: "Active Sessions",
      activeSessionsSub: (sessions: Readonly<MiniAppActiveSessionCounts>): string =>
        `Gag ${sessions.gag} · Wed ${sessions.wed} · Verify ${sessions.verify} · QA ${sessions.qaSet}`,
      outboundGateLabel: "Telegram Outbound Gate",
      outboundGateSub: (waiting: number, retrySize: number, retryMax: number): string =>
        `Waiting ${waiting} · Retry ${retrySize}/${retryMax}`,
      capabilitiesSectionTitle: "Subsystem Readiness & Configs",
      capabilityReadyBadge: "Ready",
      capabilityMissingBadge: "Unconfigured",
      capabilityLabel: (capability: Readonly<MiniAppCapabilityStatus>): string =>
        capabilityLabels[capability.key] ?? capability.label,
      capabilityItem: (
        item: Readonly<MiniAppCapabilityDetailItem>
      ): Readonly<MiniAppCapabilityDetailItem> => {
        if (item.label === "图库服务") {
          return {
            label: "Gallery Service",
            value: "Supports /h_image draws & panel management",
            sub: "SHA-256 deduplicated storage",
          };
        }
        if (item.label === "运行状态") {
          return {
            label: "Runtime Status",
            value: "Not Ready",
            sub: "Missing required config",
          };
        }
        if (item.label === "翻译服务") {
          return {
            label: "Translation Service",
            value: item.value,
            sub: "Enabled",
          };
        }
        if (item.label === "检测模型") {
          return {
            label: "Detection Model",
            value: item.value,
            sub: item.sub,
          };
        }
        if (item.label === "对话 text") {
          return { label: "Chat text", value: item.value, sub: item.sub };
        }
        if (item.label === "摘要 summary") {
          return { label: "Summary", value: item.value, sub: item.sub };
        }
        if (item.label === "多模态 media") {
          return { label: "Multimodal media", value: item.value, sub: item.sub };
        }
        if (item.label === "生图 image") {
          return { label: "Image Gen", value: item.value, sub: item.sub };
        }
        if (item.label === "语音 tts") {
          return {
            label: "Speech tts",
            value: item.value,
            sub: item.sub?.replace("音色 ", "Voice "),
          };
        }
        if (item.label === "搜索 search") {
          return {
            label: "Web Search",
            value: item.value,
            sub: item.sub
              ?.replace("限 ", "Max ")
              .replace(" 次/轮", " calls/turn"),
          };
        }
        if (item.label.startsWith("贴纸包 #")) {
          return {
            label: item.label.replace("贴纸包 #", "Sticker Pack #"),
            value: item.value,
            sub: item.sub,
          };
        }
        if (item.label === "贴纸包") {
          return { label: "Sticker Pack", value: "Not Loaded", sub: item.sub };
        }
        if (item.label === "情绪池") {
          return { label: "Mood Pool", value: "Not Loaded", sub: item.sub };
        }
        if (item.value.startsWith("权重 ")) {
          return {
            label: item.label,
            value: item.value.replace("权重 ", "Weight "),
            sub: item.sub,
          };
        }
        if (item.label === "定时任务") {
          return {
            label: "Cron Tasks",
            value: item.value === "未加载" ? "Not Loaded" : "No configured tasks",
            sub: item.sub,
          };
        }
        if (item.sub !== undefined) {
          return {
            label: item.label,
            value: item.value,
            sub: item.sub
              .replace("全部受管群", "All managed chats")
              .replace(/排除 (\d+) 群/u, "Except $1 chats")
              .replace(/(\d+) 个指定会话/u, "$1 specified chats"),
          };
        }
        return item;
      },
    },
    chats: {
      sectionTitle: (count: number): string => `/init Managed Groups (${count})`,
      refreshButton: "Refresh",
      loadingChatsText: "Counting your managed groups, Zaako…",
      emptyChatsHint:
        "Tsk, not a single group has /init enabled yet! Go run /init enable in a group first, Zaako♡",
      lockdownBadge: "Lockdown Active",
      chatCardMeta: (chatId: number, hotCount: number, qaCount: number): string =>
        `ID: ${chatId} · Hot Msgs ${hotCount} · QA ${qaCount}`,
      detailSectionTitle: "Manage",
      viewMessagesButton: (hotCount: number, hotMax: number): string =>
        `Peek Msgs (${hotCount}/${hotMax})`,
      closeDetailButton: "Close",
      botPermProbing: "Bot Admin Perms: Not probed yet, run a command in the group first",
      botPermAllReady: "Bot Admin Perms: Delete / Restrict / Pin Info all granted",
      botPermMissingTitle: (count: number): string =>
        `Missing Bot Admin Permissions (${count})`,
      botPermLabel: (rawLabel: string): string => {
        const map: Readonly<Record<string, string>> = {
          管理员身份: "Administrator",
          匿名身份: "Remain Anonymous",
          管理聊天: "Manage Chat",
          删除消息: "Delete Messages",
          管理视频聊天: "Manage Video Chats",
          限制与封禁成员: "Ban Users",
          任免管理员: "Add New Admins",
          修改聊天资料: "Change Chat Info",
          邀请用户: "Invite Users",
          管理成员标签: "Manage Member Tags",
          发布故事: "Post Stories",
          编辑故事: "Edit Stories",
          删除故事: "Delete Stories",
          频道发布消息: "Post Messages",
          编辑频道消息: "Edit Messages",
          置顶消息: "Pin Messages",
          管理论坛话题: "Manage Topics",
          管理频道私信: "Manage Direct Messages",
        };
        return map[rawLabel] ?? rawLabel;
      },
      detailStatsLine: (detail: Readonly<MiniAppChatDetail>): string =>
        `Chat ID: ${detail.chatId} · QA Pairs: ${detail.qaPairCount} · Auto-Delete: ${detail.deleteMessageTargetCount} · Auto-Translate: ${detail.translateTargetCount}`,
      featuresSectionTitle: "Live Group Feature Switches",
      confirmDisableInit:
        "Zaako, are you sure you want to disable /init for this group? All runtime caches for it will be wiped and it'll be removed from the list!",
      featureMeta: {
        init: {
          label: "Master Group Switch (/init)",
          command: "/init",
          description: "Turning this off kicks the group out of the managed list and wipes its hot state",
        },
        aiChat: {
          label: "AI Chat & Memory (/ai_chat)",
          command: "/ai_chat",
          description: "Enable this Genius's AI replies, hot context buffer, and rolling summaries",
        },
        translation: {
          label: "Auto Translation (/translate)",
          command: "/translate",
          description: "Toggle group-wide auto translation and targeted member translation",
        },
        adDetect: {
          label: "AI Ad Detection (/ad_detect)",
          command: "/ad_detect",
          description: "Classify non-whitelisted messages for spam ads and auto-moderate",
        },
        floodControl: {
          label: "Flood Mute Guard (/flood_control)",
          command: "/flood_control",
          description: "Automatically mute noisy members spamming within the sliding window",
        },
        antiRaid: {
          label: "Anti-Raid Join Guard (/antiraid)",
          command: "/antiraid",
          description: "Detect abnormal join spikes and trigger private lockdown mode",
        },
        proxySend: {
          label: "Proxy Send Target (/send)",
          command: "/send",
          description: "Set this group as the destination when you use /send in private chat",
        },
      },
    },
    messages: {
      backButton: "Back to Group",
      refreshButton: "Refresh",
      headerTitle: (title: string, total: number, maxCapacity: number): string =>
        `${title} · Hot Msgs (${total}/${maxCapacity})`,
      headerMeta: (chatId: number): string =>
        `Chat ID: ${chatId} · Showing only the latest 256 hot buffer messages (compressed summaries are off-limits, Zaako)`,
      loadingText: "Flipping through the hot message buffer for you…",
      emptyHint: "The hot buffer for this group is completely empty, Zaako",
      replyBadge: (name: string, preview: string): string =>
        `Reply to ${name}${preview.length > 0 ? `: ${preview}` : ""}`,
      forwardBadge: (from: string): string => `Forwarded from ${from}`,
      emptyMediaPlaceholder: "(Media message without text)",
    },
    identities: {
      whitelistTab: "Permissions",
      blocklistTab: "Blocklist",
      searchPlaceholder: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "Search whitelist name / @username / ID"
          : "Search blocklist name / @username / ID",
      searchClearAria: "Clear search query",
      searchDebounceHint: "0.5s debounced searching…",
      addFoldButton: "Add User",
      addModes: {
        id: "Add by Numeric ID",
        users: "Pick Contact / User",
        channel: "Pick Broadcast Channel",
      },
      addModeDescriptions: {
        id: "Enter a positive user ID or a -100... channel ID directly",
        users: "Open Telegram's native contact picker to select friends",
        channel: "Open Telegram's native channel picker to select a channel",
      },
      idInputPlaceholder: "Enter positive user ID or -100... channel ID",
      idConfirmButton: "Add Now",
      idCancelButton: "Cancel",
      invalidIdToast: "Clueless Zaako! Enter a valid non-zero integer ID (e.g. 123456789 or -1001234567890)!",
      duplicateToast: (idText: string, subTab: MiniAppIdentitySubTabKey): string =>
        `Clueless Zaako! ${idText} is already in the ${subTab === "whitelist" ? "whitelist" : "blocklist"}! No duplicates allowed!`,
      duplicateBannerTitle: "Duplicate Blocked",
      pickerUnsupportedHint:
        "Your current client doesn't support Telegram.WebApp.requestChat, Zaako. Open from the Telegram app or use 'Add by Numeric ID'!",
      pickerWaitingToast: "Opened Telegram native picker, go pick someone Zaako…",
      pickerCancelledToast: "Hmph, you cancelled the picker halfway through, indecisive Zaako",
      pickerTimeoutToast: "Timed out waiting for picker receipt, hit refresh manually Zaako",
      loadingText: "Reading the identity ledger for you…",
      emptySearchHint: (query: string): string =>
        `Tsk, no entry matching "${query}" found. Did you mistype it, Zaako?`,
      emptyListHint: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "The whitelist is completely empty! Click '+ Add User' to add someone, Zaako♡"
          : "Nobody is in the blocklist yet! Click '+ Add User' to lock someone up, Zaako♡",
      channelBadge: "CH",
      userBadge: "USER",
      blockedAtText: (timeText: string): string => `Blocked at ${timeText}`,
      enabledPermCountText: (enabledCount: number, totalCount: number): string =>
        `${enabledCount}/${totalCount} permissions enabled`,
      configurePermButton: "Permissions",
      removeWhitelistButton: "Remove",
      removeBlocklistButton: "Unblock",
      confirmRemoveWhitelist: (displayName: string, id: number): string =>
        `Zaako, kick ${displayName} (${id}) out of the whitelist?`,
      confirmRemoveBlocklist: (displayName: string, id: number): string =>
        `Zaako, release ${displayName} (${id}) from the blocklist and unban across managed chats?`,
    },
    permissionDrawer: {
      title: (displayName: string): string => `${displayName}'s Permissions`,
      subtitle: (id: number, isChannel: boolean): string =>
        `ID: ${id} · ${isChannel ? "Channel" : "User"} · Live SQLite sync`,
      enableAllButton: "Enable All 18",
      closeButton: "Close",
      labels: {
        isCanMute: "/mute Manual Mute",
        isCanUnMute: "/unmute Unmute Member",
        isCanGag: "/gag Interactive Gag",
        isCanViewBotStatus: "/bot_status View Bot Status",
        isCanBlock: "/block Add to Blocklist",
        isCanUnBlock: "/unblock Remove from Blocklist",
        isCanWhiteOther: "/white Whitelist Others",
        isCanSwitchMood: "/switch_mood Switch Bot Mood",
        isCanBypassAdDetection: "Bypass Ad Detection",
        isCanBypassFloodControl: "Bypass Flood Mute Guard",
        isCanControllAIPermission: "/ai_chat Switch Control",
        isCanClearContext: "/clear Wipe AI Context",
        isCanControllAdDetectPermission: "/ad_detect Switch Control",
        isCanControllFloodControlPermission: "/flood_control Switch Control",
        isCanControllTranslatePermission: "/translate Switch Control",
        isCanControllAntiRaidPermission: "/antiraid Switch Control",
        isCanControllQaPermission: "/qa Manage QA Pairs",
        isCanAddHImage: "/h_image add Upload H-Images",
      },
    },
    gallery: {
      sectionTitle: "Gallery",
      refreshButton: "Refresh",
      uploadingButton: "Storing…",
      uploadButton: "Upload Image",
      directoryMissingText: (_directory: string): string =>
        "Gallery storage is not ready yet, won't auto-create it",
      directoryReadyText: (_directory: string): string =>
        "Gallery storage ready · JPEG / PNG / WebP (≤ 10 MiB)",
      previewTitle: (shortName: string): string => `Preview · ${shortName}`,
      downloadButton: "Download",
      downloadingButton: "Saving…",
      downloadedToast: (fileName: string): string =>
        `Downloaded ${fileName} for you, Zaako♡`,
      deleteButton: "Delete Image",
      deletingButton: "Deleting…",
      closePreviewButton: "Close Preview",
      confirmDeleteImage: (fileName: string): string =>
        `Zaako, permanently delete this image (${fileName}) from the gallery? There's no undo!`,
      deletedToast: (fileName: string): string =>
        `Hmph, deleted ${fileName} from the gallery for you, Zaako♡`,
      loadingText: "Flipping through the gallery album for you…",
      emptyMissingDirHint:
        "The configured gallery directory doesn't exist yet! Go create it on the server first, Zaako",
      emptyGalleryHint:
        "Not a single image in the gallery yet! Click 'Upload Image' to stuff some in, Zaako♡",
    },
  };
}
