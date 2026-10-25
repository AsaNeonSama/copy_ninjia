import type {
  MiniAppActiveSessionCounts,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppIdentitySubTabKey,
} from "../../../types/miniApp";
import type { MiniAppTranslations } from "../../../types/miniAppI18n";

/**
 * 返回简体中文（杂鱼语气）的 Mini App 界面文案字典。
 *
 * @returns 中文界面文案对象
 */
export function getZhTranslations(): Readonly<MiniAppTranslations> {
  const capabilityLabels: Readonly<Record<string, string>> = {
    aiChat: "AI 群聊与多模态",
    translate: "自动翻译引擎",
    adDetect: "AI 广告检测",
    stickers: "贴纸包目录",
    mood: "AI 情绪池",
    cron: "定时播报任务",
    hImage: "随机色图图库 (/h_image)",
    randomHImage: "随机色图图库 (/h_image)",
  };
  return {
    languageLabel: "中",
    appTitle: "Bot 控制台♡",
    appSubtitle: "专为杂鱼管理员准备的本天才指挥舱",
    superAdminBadge: "SuperAdmin",
    lockButton: "锁定",
    lockSessionToast: "哼，已经帮粗心的杂鱼把会话锁上啦♡",
    sessionExpiredToast: "杂鱼，90 分钟会话早就过期啦，快乖乖重输密码！",
    themeLightLabel: "亮色",
    themeDarkLabel: "暗色",
    sidebarTitle: "导航菜单",
    sidebarSubtitle: "杂鱼想去哪个模块巡视呀？",
    sidebarOpenAria: "展开侧边导航菜单",
    sidebarCloseAria: "收起侧边导航菜单",
    sidebarFooterHint: "本天才全天候帮杂鱼盯着系统状态呢♡",
    tabs: {
      status: "实时状态",
      chats: "受管群聊",
      identities: "权限控制",
      gallery: "色图图库",
      totp: "验证器",
    },
    tabDescriptions: {
      status: "CPU、内存、出站门控与子系统状态",
      chats: "已 /init 群开关与热 256 条发言",
      identities: "白名单 18 项权限与黑名单管理",
      gallery: "/h_image 图库预览、上传与删除",
      totp: "谷歌验证器 (TOTP) 绑定、替换与删除",
    },
    gate: {
      checkingText: "本天才正在核验杂鱼的 SuperAdmin 签名，老实等着…",
      deniedTitle: "禁止访问啦，杂鱼♡",
      deniedDescription:
        "哼，你没有权限从外部浏览器或未经授权的客户端偷看这个控制台哦，杂鱼。",
      deniedNodeClientSub: "访问端",
      deniedNodeClientTitle: "杂鱼的浏览器",
      deniedNodeClientState: "运行中",
      deniedNodeGatewaySub: "访问网关",
      deniedNodeGatewayTitle: "鉴权守卫",
      deniedNodeGatewayState: (status: number): string => `${status} 已拦截`,
      deniedNodeOriginSub: "源站服务",
      deniedNodeOriginState: "受保护中",
      deniedWhatHappenedTitle: "发生什么事啦，杂鱼？",
      deniedWhatHappenedDesc:
        "这个端点强制执行严格的 Telegram WebApp 签名校验与超级管理员门禁控制哦。杂鱼刚才发出的请求没能通过策略校验，已经被直接踢回去啦♡",
      deniedPolicyDetailLabel: (code: string): string => `策略详情 (${code})`,
      deniedPolicyReason: (code: string, fallbackError: string): string => {
        const upper: string = code.toUpperCase();
        if (
          upper === "MISSING_INIT_DATA" ||
          upper === "MALFORMED_INIT_DATA" ||
          upper === "MISSING_HASH" ||
          upper === "MISSING_USER"
        ) {
          return `Telegram WebApp initData 校验失败（${code}），严禁从外部浏览器直接偷看哦，杂鱼`;
        }
        if (upper === "INVALID_SIGNATURE") {
          return `Telegram WebApp 签名校验失败（${code}），伪造签名也是没用的哦，杂鱼`;
        }
        if (upper === "EXPIRED_AUTH_DATE") {
          return `Telegram WebApp 签名凭据已过期（${code}），快回 Telegram 重新点开面板刷新签名吧，杂鱼`;
        }
        if (upper === "FORBIDDEN_USER") {
          return "只有配置好的超级管理员本尊才能进入这个 Mini App 哦，杂鱼就别乱碰啦";
        }
        if (upper === "CROSS_SITE_FORBIDDEN") {
          return `跨站请求已被直接拦截（${code}），杂鱼别想从奇怪的地方发起调用哦`;
        }
        return fallbackError;
      },
      deniedWhatCanIDoTitle: "杂鱼现在该怎么办？",
      deniedWhatCanIDoDesc:
        "严禁在 Telegram 之外直接通过 HTTP 访问哦。如果你真是超级管理员本尊，就乖乖去 Telegram 打开与 Bot 的私聊，点击 App 按钮并输入访问密码吧，杂鱼。",
      passwordBadge: "二次密码门禁",
      passwordTitle: "交出访问密码，杂鱼♡",
      passwordSubtitle:
        "Telegram 签名倒是勉强过关了，再输入控制台访问密码解锁 90 分钟会话吧（连续输错 3 次直接锁你 30 分钟哦）。",
      passwordPlaceholder: "快输入访问密码，别输错哦杂鱼…",
      passwordEmptyHint: "笨蛋杂鱼，密码框还是空的就想蒙混过关？",
      passwordSubmitting: "本天才核验中…",
      passwordSubmitButton: "乖乖解锁控制台",
      totpBadge: "谷歌验证器门禁",
      totpTitle: "交出 6 位动态码，杂鱼♡",
      totpSubtitle:
        "已启用 Google Authenticator 验证器优先保护，请输入当前 6 位动态验证码解锁 90 分钟会话（连续输错 3 次锁定 30 分钟哦）。",
      totpPlaceholder: "输入 6 位谷歌验证器动态码…",
      totpEmptyHint: "笨蛋杂鱼，先填满 6 位数字动态验证码再点解锁啦！",
      totpSubmitButton: "验证动态码并解锁",
      unlockedToast: "哼，算你识相，90 分钟会话给你解锁啦♡",
    },
    totp: {
      sectionTitle: "Google Authenticator 验证器",
      enabledBadge: "已启用优先验证",
      disabledBadge: "未启用 (使用密码)",
      statusDescEnabled: (maskedSecret: string, updatedAtText: string): string =>
        `当前唯一验证器密钥：${maskedSecret} · 更新于 ${updatedAtText}（登录时优先使用验证器）`,
      statusDescDisabled:
        "尚未绑定谷歌验证器，当前使用 bot.json 访问密码登录。仅限在本控制台生成二维码绑定唯一验证器。",
      addButton: "添加验证器",
      modifyButton: "修改验证器",
      deleteButton: "删除验证器",
      qrGuideText:
        "请用 Google Authenticator 扫描下方二维码（或手动输入 Base32 密钥），然后输入显示的 6 位动态码完成激活：",
      secretLabel: "Base32 密钥：",
      codePlaceholder: "输入 6 位动态验证码…",
      verifyEnableButton: "验证并保存",
      verifyingButton: "验证中…",
      cancelSetupButton: "取消",
      confirmDeleteTotp:
        "杂鱼，确定要删除当前的 Google Authenticator 验证器吗？删除后将恢复使用访问密码验证哦！",
    },
    pagination: {
      summary: (total: number, page: number, totalPages: number): string =>
        `共 ${total} 条 · 第 ${page}/${totalPages} 页`,
      pageSizeOption: (size: number): string => `${size}/页`,
      firstPageAria: "首页",
      prevPageAria: "上页",
      nextPageAria: "下页",
      lastPageAria: "末页",
    },
    confirmDialog: {
      title: "本天才的二次确认",
      confirmButton: "确认执行",
      cancelButton: "算了，手滑啦",
    },
    status: {
      loadingText: "正在帮杂鱼读取实时运行状态，别催啦…",
      uptimeLabel: "进程运行时长",
      updatedAtSub: (timeText: string): string => `刷新于 ${timeText}`,
      cpuLoadLabel: "CPU 平均负载",
      cpuLoadSub: "采样窗口平滑占用率",
      memoryCurrentLabel: "当前内存",
      memoryPeakLabel: "峰值内存",
      memoryHeapLabel: "JS 堆内存",
      memoryProcessUsedLabel: "当前进程内存占用",
      memoryOtherUsedLabel: "其他进程内存占用",
      memoryTotalUsedLabel: "总占用",
      memorySub: (currentRss: string, heapUsed: string): string =>
        `当前 RSS ${currentRss} · 堆 ${heapUsed}`,
      memoryHeapSub: (heapUsed: string): string => `JS 堆占用 ${heapUsed}`,
      managedChatsLabel: "已 /init 受管群",
      managedChatsSub: (whitelistCount: number, blocklistCount: number): string =>
        `白名单 ${whitelistCount} · 黑名单 ${blocklistCount}`,
      activeSessionsLabel: "活跃交互会话",
      activeSessionsSub: (sessions: Readonly<MiniAppActiveSessionCounts>): string =>
        `口球 ${sessions.gag} · 娶群友 ${sessions.wed} · 验证 ${sessions.verify} · 问答 ${sessions.qaSet}`,
      outboundGateLabel: "Telegram 出站门控",
      outboundGateSub: (waiting: number, retrySize: number, retryMax: number): string =>
        `排队 ${waiting} · 重试队列 ${retrySize}/${retryMax}`,
      capabilitiesSectionTitle: "功能配置与子系统就绪度",
      capabilityReadyBadge: "已就绪",
      capabilityMissingBadge: "未配置",
      capabilityLabel: (capability: Readonly<MiniAppCapabilityStatus>): string =>
        capabilityLabels[capability.key] ?? capability.label,
      capabilityItem: (
        item: Readonly<MiniAppCapabilityDetailItem>
      ): Readonly<MiniAppCapabilityDetailItem> => item,
    },
    chats: {
      sectionTitle: (count: number): string => `已启用 /init 的受管群聊 (${count})`,
      refreshButton: "刷新",
      loadingChatsText: "正在帮杂鱼清点受管群列表…",
      emptyChatsHint:
        "啧，现在连一个开启 /init 的群都没有呢，杂鱼快去群里发送 /init enable 吧♡",
      lockdownBadge: "封锁冷却中",
      chatCardMeta: (chatId: number, hotCount: number, qaCount: number): string =>
        `ID: ${chatId} · 热发言 ${hotCount} 条 · QA ${qaCount} 条`,
      detailSectionTitle: "管理开关",
      viewMessagesButton: (hotCount: number, hotMax: number): string =>
        `偷看发言 (${hotCount}/${hotMax})`,
      closeDetailButton: "收起",
      botPermProbing: "Bot 管理员权限：本天才还没探测过呢，去群里发条命令吧",
      botPermAllReady: "Bot 管理员权限：删消息 / 禁言封禁 / 改群资料 全都齐活啦",
      botPermMissingTitle: (count: number): string =>
        `Bot 缺少以下 ${count} 项管理员权限`,
      botPermLabel: (rawLabel: string): string => rawLabel,
      detailStatsLine: (detail: Readonly<MiniAppChatDetail>): string =>
        `群 ID: ${detail.chatId} · 问答对: ${detail.qaPairCount} · 追着删目标: ${detail.deleteMessageTargetCount} · 追着翻目标: ${detail.translateTargetCount}`,
      featuresSectionTitle: "群功能实时开关",
      confirmDisableInit:
        "杂鱼，确定要关掉这个群的 /init 总开关吗？关掉之后运行时缓存会被彻底清空并移出列表哦！",
      featureMeta: {
        init: {
          label: "群受管总开关 (/init)",
          command: "/init",
          description: "关闭后会把该群从受管列表踢出去，并清理内存热状态",
        },
        aiChat: {
          label: "AI 群聊与记忆 (/ai_chat)",
          command: "/ai_chat",
          description: "启用本天才的群内 AI 回复、热上下文缓冲与滚动摘要",
        },
        translation: {
          label: "全群自动翻译 (/translate)",
          command: "/translate",
          description: "开启或关闭全群消息自动翻译与目标成员追翻",
        },
        adDetect: {
          label: "AI 广告检测 (/ad_detect)",
          command: "/ad_detect",
          description: "对非白名单新发言进行广告分类识别与自动处置",
        },
        floodControl: {
          label: "防刷屏禁言 (/flood_control)",
          command: "/flood_control",
          description: "滑动窗口内高频刷屏时自动禁言吵闹的群成员",
        },
        antiRaid: {
          label: "入群突袭守卫 (/antiraid)",
          command: "/antiraid",
          description: "检测短时间内异常扎堆入群并自动进入私密封锁模式",
        },
        proxySend: {
          label: "私聊代发目标群 (/send)",
          command: "/send",
          description: "把该群设成杂鱼在私聊里用 /send 代发消息的目标群",
        },
      },
    },
    messages: {
      backButton: "返回群详情",
      refreshButton: "刷新",
      headerTitle: (title: string, total: number, maxCapacity: number): string =>
        `${title} · 热发言 (${total}/${maxCapacity})`,
      headerMeta: (chatId: number): string =>
        `群 ID: ${chatId} · 仅展示最近 256 条热缓冲区发言，压缩摘要才不给杂鱼看呢`,
      loadingText: "正在帮杂鱼翻阅热发言记录…",
      emptyHint: "这个群的热缓冲区里空空如也，一条发言都没有呢杂鱼♡",
      replyBadge: (name: string, preview: string): string =>
        `回复 ${name}${preview.length > 0 ? `: ${preview}` : ""}`,
      forwardBadge: (from: string): string => `转发自 ${from}`,
      emptyMediaPlaceholder: "(无文本媒体消息)",
    },
    identities: {
      whitelistTab: "权限",
      blocklistTab: "黑名单",
      searchPlaceholder: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "搜索白名单名称 / @用户名 / ID"
          : "搜索黑名单名称 / @用户名 / ID",
      searchClearAria: "清空搜索词",
      searchDebounceHint: "0.5s 防抖检索中…",
      addFoldButton: "添加用户",
      addModes: {
        id: "按数字 ID 添加",
        users: "按联系人选择添加",
        channel: "按频道选择添加",
      },
      addModeDescriptions: {
        id: "直接输入用户正整数 ID 或 -100 开头的频道 ID",
        users: "唤起 Telegram 原生联系人多选器挑选好友",
        channel: "唤起 Telegram 原生频道选择器挑选广播频道",
      },
      idInputPlaceholder: "输入用户正整数 ID 或 -100... 频道 ID",
      idConfirmButton: "确认塞进去",
      idCancelButton: "收起",
      invalidIdToast: "笨蛋杂鱼，连非零整数 ID 都不会填吗（例如 123456789 或 -1001234567890）！",
      duplicateToast: (idText: string, subTab: MiniAppIdentitySubTabKey): string =>
        `笨蛋杂鱼，${idText} 早就已经在${subTab === "whitelist" ? "白名单" : "黑名单"}里啦，不许重复添加！`,
      duplicateBannerTitle: "重复添加拦截",
      pickerUnsupportedHint:
        "杂鱼当前的客户端环境不支持 Telegram.WebApp.requestChat，老老实实从 Telegram 客户端打开或者改用「按数字 ID 添加」吧",
      pickerWaitingToast: "已在 Telegram 弹出选择器，快去挑人吧杂鱼…",
      pickerCancelledToast: "哼，杂鱼居然半途取消了选择器操作♡",
      pickerTimeoutToast: "等半天都没收到选择器回执，杂鱼手动刷新看看吧",
      loadingText: "正在帮杂鱼翻名单册子…",
      emptySearchHint: (query: string): string =>
        `啧，找不到名称或 ID 包含「${query}」的目标呢，杂鱼是不是拼错啦？`,
      emptyListHint: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "白名单里空荡荡的呢，点右上角「添加用户」塞几个进来吧杂鱼"
          : "黑名单里还没有倒霉蛋呢，点右上角「添加用户」关几个进来吧杂鱼",
      channelBadge: "频道",
      userBadge: "用户",
      blockedAtText: (timeText: string): string => `拉黑于 ${timeText}`,
      enabledPermCountText: (enabledCount: number, totalCount: number): string =>
        `已开启 ${enabledCount}/${totalCount} 项权限`,
      configurePermButton: "权限配置",
      removeWhitelistButton: "移出",
      removeBlocklistButton: "解封",
      confirmRemoveWhitelist: (displayName: string, id: number): string =>
        `杂鱼，确定要把 ${displayName} (${id}) 从白名单踢出去吗？`,
      confirmRemoveBlocklist: (displayName: string, id: number): string =>
        `杂鱼，确定要把 ${displayName} (${id}) 从黑名单放出来并在受管群解封吗？`,
    },
    permissionDrawer: {
      title: (displayName: string): string => `${displayName} 的权限开关`,
      subtitle: (id: number, isChannel: boolean): string =>
        `ID: ${id} · ${isChannel ? "频道身份" : "用户身份"} · 实时落盘 SQLite`,
      enableAllButton: "一键全开 18 项",
      closeButton: "收起",
      labels: {
        isCanMute: "/mute 手动禁言",
        isCanUnMute: "/unmute 解除禁言",
        isCanGag: "/gag 互动塞口球",
        isCanViewBotStatus: "/bot_status 查看运行状态",
        isCanBlock: "/block 拉人进黑名单",
        isCanUnBlock: "/unblock 解除黑名单",
        isCanWhiteOther: "/white 代加他人进白名单",
        isCanSwitchMood: "/switch_mood 切换本天才心情",
        isCanBypassAdDetection: "广告检测免检特权",
        isCanBypassFloodControl: "防刷屏禁言免检特权",
        isCanControllAIPermission: "/ai_chat 开关控制",
        isCanClearContext: "/clear 清空 AI 上下文",
        isCanControllAdDetectPermission: "/ad_detect 开关控制",
        isCanControllFloodControlPermission: "/flood_control 开关控制",
        isCanControllTranslatePermission: "/translate 开关控制",
        isCanControllAntiRaidPermission: "/antiraid 开关控制",
        isCanControllQaPermission: "/qa 问答词条管理",
        isCanAddHImage: "/h_image add 往图库塞图",
      },
    },
    gallery: {
      sectionTitle: "色图图库",
      refreshButton: "刷新",
      uploadingButton: "入库中…",
      uploadButton: "上传新图",
      directoryMissingText: (_directory: string): string =>
        "图库存储尚未就绪，本天才不会自动建目录哦",
      directoryReadyText: (_directory: string): string =>
        "图库存储已就绪 · 支持 JPEG / PNG / WebP (≤ 10 MiB)",
      previewTitle: (shortName: string): string => `大图预览 · ${shortName}`,
      downloadButton: "下载图片",
      downloadingButton: "下载中…",
      downloadedToast: (fileName: string): string =>
        `已经帮杂鱼把 ${fileName} 下载好啦♡`,
      deleteButton: "删除图片",
      deletingButton: "删除中…",
      closePreviewButton: "关闭预览",
      confirmDeleteImage: (fileName: string): string =>
        `杂鱼，确定要从图库永久删掉这张图片 (${fileName}) 吗？删掉可就找不回来咯！`,
      deletedToast: (fileName: string): string =>
        `哼，已经帮杂鱼把 ${fileName} 从图库删掉啦♡`,
      loadingText: "正在帮杂鱼翻找图库相册…",
      emptyMissingDirHint:
        "当前配置的图库目录还不存在呢，杂鱼快去服务器上建好目录再来看吧",
      emptyGalleryHint:
        "图库目录里连一张图都没有呢，杂鱼快点右上角「上传新图」塞几张进来吧♡",
    },
  };
}
